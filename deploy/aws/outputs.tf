output "public_ip" {
  description = "Elastic IP — point relay.<zone> and *.relay.<zone> here (DNS-only)."
  value       = aws_eip.relay.public_ip
}

output "instance_id" {
  value = aws_instance.relay.id
}

output "backup_bucket" {
  description = "Nightly SQLite backups land here under YYYY/MM/DD/."
  value       = aws_s3_bucket.backups.bucket
}

output "secret_name" {
  description = "Secrets Manager entry to fill by hand with the host's secrets."
  value       = aws_secretsmanager_secret.host.name
}

output "ssh_admin" {
  value = "ssh -i ~/.ssh/dash-prod ubuntu@${aws_eip.relay.public_ip}"
}
