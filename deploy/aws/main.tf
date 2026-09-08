# One EC2 host for the hosted relay + control plane (deploy/server/), plus the
# backups and alarms around it. See ../../docs/plans (AWS production host plan)
# for the reasoning and README.md for how to apply this.

data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

resource "aws_security_group" "relay" {
  name        = "${var.name}-sg"
  description = "Hosted relay + control plane behind Traefik"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description      = "HTTPS (relay + control plane)"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTP (Traefik redirect to HTTPS only)"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  # GitHub-hosted runners have no fixed egress IPs, so the deploy user's SSH is
  # world-reachable: key-only auth, no password, no sudo, fail2ban (cloud-init).
  # Replacing this with SSM is the listed hardening follow-up.
  ingress {
    description      = "SSH (key-only; admin + GitHub Actions deploy user)"
    from_port        = 22
    to_port          = 22
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

resource "aws_eip" "relay" {
  domain = "vpc"
}

resource "aws_eip_association" "relay" {
  instance_id   = aws_instance.relay.id
  allocation_id = aws_eip.relay.id
}

# ---------------------------------------------------------------------------
# Logical backups: nightly SQLite .backup → S3 (see cloud-init dash-backup)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "backups" {
  bucket = "${var.name}-backups-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ---------------------------------------------------------------------------
# Instance role: write backups, ship container logs. No keys on the box.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "containers" {
  name              = "/${var.name}/containers"
  retention_in_days = 30
}

data "aws_iam_policy_document" "instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "instance" {
  statement {
    sid       = "WriteBackups"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    sid       = "ShipContainerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.containers.arn}:*"]
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.instance_assume.json
}

resource "aws_iam_role_policy" "instance" {
  name   = "${var.name}-instance"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

# ---------------------------------------------------------------------------
# The host
# ---------------------------------------------------------------------------

resource "aws_key_pair" "admin" {
  key_name   = "${var.name}-admin"
  public_key = var.admin_public_key
}

locals {
  cloud_init = templatefile("${path.module}/cloud-init.yaml", {
    deploy_public_key = var.deploy_public_key
    backup_bucket     = aws_s3_bucket.backups.bucket
    region            = var.region
    log_group         = aws_cloudwatch_log_group.containers.name
    acme_email        = var.acme_email
  })
}

resource "aws_instance" "relay" {
  ami                    = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.relay.id]
  key_name               = aws_key_pair.admin.key_name
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  # cloud-init runs on FIRST boot only. A changed cloud-init.yaml does not
  # reconfigure a running host — rebuild it (README "Rebuilding the host").
  user_data_base64            = base64gzip(local.cloud_init)
  user_data_replace_on_change = false

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required" # IMDSv2 only — the instance role is not reachable by plain GET
  }

  tags = {
    Name   = var.name
    Backup = "daily"
  }

  lifecycle {
    ignore_changes = [ami] # a newer Ubuntu AMI must not replace the host by surprise
  }
}

# ---------------------------------------------------------------------------
# EBS snapshots: AWS Backup, daily, keep N days
# ---------------------------------------------------------------------------

resource "aws_backup_vault" "relay" {
  name = "${var.name}-vault"
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "relay" {
  name = "${var.name}-daily"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.relay.name
    schedule          = "cron(0 20 * * ? *)" # 20:00 UTC = 04:00 Singapore
    lifecycle {
      delete_after = var.backup_retention_days
    }
  }
}

resource "aws_backup_selection" "relay" {
  name         = "${var.name}-instance"
  plan_id      = aws_backup_plan.relay.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_instance.relay.arn]
}

# ---------------------------------------------------------------------------
# Alarms: public /health (Route53, us-east-1) and instance status checks
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_sns_topic" "alarms_use1" {
  provider = aws.use1
  name     = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "alarms_use1_email" {
  provider  = aws.use1
  topic_arn = aws_sns_topic.alarms_use1.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_route53_health_check" "cp" {
  fqdn              = var.cp_host
  port              = 443
  type              = "HTTPS_STR_MATCH"
  resource_path     = "/health"
  search_string     = "healthy"
  failure_threshold = 3
  request_interval  = 30
  tags = {
    Name = "${var.name}-cp-health"
  }
}

resource "aws_cloudwatch_metric_alarm" "cp_health" {
  provider            = aws.use1
  alarm_name          = "${var.name}-cp-health"
  alarm_description   = "Control plane /health is failing from the public internet (${var.cp_host})"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions = {
    HealthCheckId = aws_route53_health_check.cp.id
  }
  alarm_actions = [aws_sns_topic.alarms_use1.arn]
  ok_actions    = [aws_sns_topic.alarms_use1.arn]
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "${var.name}-instance-status"
  alarm_description   = "EC2 system or instance status check failing"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  dimensions = {
    InstanceId = aws_instance.relay.id
  }
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# ---------------------------------------------------------------------------
# Disaster-recovery copy of the host's secrets. Terraform creates the shell
# only; you write the value by hand (README "Secrets") so it never enters state.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "host" {
  name        = "${var.name}/host"
  description = "Copy of /srv/dash-server/.env secrets, dial-token.key and the Cloudflare DNS token, for rebuilding the host"
}
