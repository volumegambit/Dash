terraform {
  # >= 1.10 for native S3 state locking (use_lockfile), no DynamoDB table needed.
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Partial backend config — the bucket, key, and region are passed at init time
  # so this file carries no account-specific values. See README.md "State".
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "dash"
      Component   = "relay"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

# Route53 health-check metrics only exist in us-east-1, so the alarm that
# watches the public /health endpoint (and the topic it notifies) live there.
provider "aws" {
  alias  = "use1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "dash"
      Component   = "relay"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
