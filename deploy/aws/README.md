# AWS production host

Terraform for the single EC2 host that runs the hosted relay + control plane
(`deploy/server/`) for `relay.dashsquad.ai`, with its backups and alarms. The
reasoning is in the plans repo (`2026-09-08-aws-production-host-plan.md`); the
day-two operations (deploying, rolling back, secrets) are in `../README.md`.

What `terraform apply` creates: security group (443, 80, 22), Elastic IP, one
`t3.small` Ubuntu 24.04 instance (encrypted gp3 root, IMDSv2 only, instance
profile), an S3 bucket for nightly SQLite backups, an AWS Backup plan for daily
EBS snapshots, a Route53 health check on `api.relay.dashsquad.ai/health` with a
CloudWatch alarm, an instance status-check alarm, SNS email for both, and an
empty Secrets Manager entry you fill by hand. cloud-init on first boot installs
Docker, the `deploy` user, fail2ban, unattended security upgrades, the Traefik
compose file, the `/srv/dash-server` layout, and the backup timer.

## Prerequisites

- `terraform` ≥ 1.10 and the `aws` CLI, signed in through IAM Identity Center
  (`aws configure sso`, then `aws sso login`) — no long-lived access keys.
- Two SSH keypairs: yours (`~/.ssh/dash-prod`) and the deploy key GitHub Actions
  will use (`ssh-keygen -t ed25519 -N '' -f /tmp/dash-deploy`).
- A Cloudflare API token scoped to *Zone / DNS / Edit* on `dashsquad.ai` (for
  Traefik's wildcard certificate; entered on the host, never here).

## State

Terraform state lives in an S3 bucket with native locking. Create the bucket
once (pick your own name):

```bash
export AWS_PROFILE=dash-prod REGION=ap-southeast-1 STATE=dash-terraform-state-<accountid>
aws s3api create-bucket --bucket "$STATE" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
aws s3api put-bucket-versioning --bucket "$STATE" --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "$STATE" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## Apply

```bash
cd deploy/aws
cp terraform.tfvars.example terraform.tfvars   # fill in keys + emails (gitignored)
terraform init \
  -backend-config="bucket=$STATE" \
  -backend-config="key=relay-prod/terraform.tfstate" \
  -backend-config="region=$REGION" \
  -backend-config="use_lockfile=true"
terraform plan -out plan.tfplan
terraform apply plan.tfplan
terraform output
```

Then, in order:

1. **Confirm the two SNS emails** (one per region). Alarms are silent until you do.
2. **DNS** (Cloudflare, DNS-only): `A relay.dashsquad.ai` and `A *.relay.dashsquad.ai`
   → `public_ip`. Wait for `dig +short api.relay.dashsquad.ai` to answer.
3. **Traefik**: `ssh ubuntu@<ip>`, `cd /srv/traefik`, `cp .env.example .env`,
   `chmod 600 .env`, paste the Cloudflare token, `docker compose up -d`. Watch
   `docker logs -f traefik` for the resolver to register. cloud-init does not
   start Traefik because the token is not there yet.
4. **The stack**: follow `../README.md` §5 — `.env`, the dial-token keypair, the
   first `deploy.sh`, the smoke, the full-loop test, one rollback drill. The
   stack directory is `/srv/dash-server`; copy `deploy/server/{docker-compose.yml,deploy.sh,smoke.sh}`
   there (the release workflow rsyncs them on every deploy).
5. **GitHub**: `../README.md` §3 with `--env production`,
   `SERVER_SSH_USER=deploy`, `SERVER_SSH_HOST=<public_ip>`,
   `SERVER_DEPLOY_DIR=/srv/dash-server`.

## Secrets

Nothing secret passes through Terraform, so the state file holds none. After
step 4, store a disaster-recovery copy in the Secrets Manager entry it created:

```bash
aws secretsmanager put-secret-value --secret-id "$(terraform output -raw secret_name)" \
  --secret-string "$(jq -n --arg env "$(ssh ubuntu@<ip> sudo cat /srv/dash-server/.env)" \
                          --arg key "$(ssh ubuntu@<ip> sudo cat /srv/dash-server/secrets/dial-token.key)" \
                          --arg cf  "$(ssh ubuntu@<ip> sudo cat /srv/traefik/.env)" \
                          '{env:$env, dial_token_key:$key, traefik_env:$cf}')"
```

## Drills before calling it production

- **Alarm**: `docker stop dash-server-cp-1` for three minutes; expect an email;
  start it again; expect the OK email.
- **Snapshot restore**: AWS Backup → restore the latest recovery point to a new
  volume, attach it to the instance, mount, read the two `.db` files, detach.
- **Logical backup**: `aws s3 ls s3://$(terraform output -raw backup_bucket)/`,
  download yesterday's file, `gunzip`, `sqlite3 x.db "pragma integrity_check"`.

## Rebuilding the host

cloud-init runs on first boot only, so a changed `cloud-init.yaml` (or a
compromised host) means a new instance, not a reconfigured one:

1. `terraform apply -replace=aws_instance.relay` (the Elastic IP re-attaches, DNS is unchanged).
2. Restore secrets from Secrets Manager into `/srv/traefik/.env`,
   `/srv/dash-server/.env`, `/srv/dash-server/secrets/dial-token.key` (+ derive
   the `.pub` with `openssl pkey -pubout`).
3. Restore the two SQLite files from the latest S3 backup into `data/relay` and
   `data/cp`, `chown 1000:1000`.
4. Start Traefik, run `deploy.sh` with the current production image, smoke.

## Notes

- **Why uid 1000 on the data dirs**: the server image runs as `node` (uid 1000).
  On Ubuntu that uid is `ubuntu`, and `deploy` is 1001. The data dirs are chowned
  to 1000 deliberately; the first deploy fails with EACCES otherwise.
- **Port 22 is open to the world** for the `deploy` user's key because
  GitHub-hosted runners have no fixed IPs. Key-only, no sudo, fail2ban. Moving
  the deploy to SSM (no inbound port) is the first hardening follow-up.
- **The AMI is pinned by `ignore_changes`**: a newer Ubuntu image does not
  replace the host on a routine apply. To take a new AMI, rebuild deliberately.
- **Logs**: every container's output is in the CloudWatch log group
  `/dash-relay-prod/containers`, one stream per container name, 30-day retention.
- `terraform destroy` removes everything except the S3 backup bucket contents
  (versioned, non-empty buckets refuse to delete) — empty it first if you mean it.
