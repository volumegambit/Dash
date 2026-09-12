variable "region" {
  description = "AWS region for the host and its backups."
  type        = string
  default     = "ap-southeast-1"
}

variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "dash-relay-prod"
}

variable "instance_type" {
  description = "x86 instance type — the server image is built for linux/amd64 only."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size (gp3, encrypted). Holds both SQLite stores."
  type        = number
  default     = 30
}

variable "admin_public_key" {
  description = "SSH public key for the `ubuntu` admin user (your key)."
  type        = string
}

variable "deploy_public_key" {
  description = "SSH public key for the `deploy` user that GitHub Actions uses (SERVER_SSH_KEY's public half)."
  type        = string
}

variable "alarm_email" {
  description = "Address that receives health-check and instance alarms (SNS asks it to confirm once)."
  type        = string
}

variable "relay_zone" {
  description = "Wildcard zone gateways are served under."
  type        = string
  default     = "relay.dashsquad.ai"
}

variable "cp_host" {
  description = "Control-plane hostname; its /health endpoint is what Route53 probes."
  type        = string
  default     = "api.relay.dashsquad.ai"
}

variable "acme_email" {
  description = "Contact email Let's Encrypt gets for the wildcard certificate."
  type        = string
}

variable "backup_retention_days" {
  description = "Days to keep daily EBS snapshots."
  type        = number
  default     = 14
}
