#!/usr/bin/env bash
# Pull every parameter under $SSM_PREFIX out of AWS Systems Manager Parameter Store
# and write it as KEY=value lines into $OUTFILE (default: .env in this directory).
#
# Run on EC2 (instance role has ssm:GetParametersByPath + kms:Decrypt) or anywhere
# the AWS CLI is configured.
set -euo pipefail

PREFIX="${SSM_PREFIX:-/trajan-advisor}"
REGION="${AWS_REGION:-us-east-1}"
OUTFILE="${OUTFILE:-$(dirname "$0")/.env}"

command -v aws >/dev/null || { echo "aws CLI not found"; exit 1; }
command -v jq  >/dev/null || { echo "jq not found (sudo dnf install -y jq)"; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

aws ssm get-parameters-by-path \
  --path "$PREFIX" \
  --recursive \
  --with-decryption \
  --region "$REGION" \
  --output json \
  | jq -r --arg prefix "$PREFIX/" '.Parameters[] | "\(.Name | ltrimstr($prefix))=\(.Value)"' \
  > "$tmp"

if ! [ -s "$tmp" ]; then
  echo "No parameters found under $PREFIX in $REGION" >&2
  exit 1
fi

mv "$tmp" "$OUTFILE"
chmod 600 "$OUTFILE"
echo "Wrote $(wc -l < "$OUTFILE" | tr -d ' ') parameters to $OUTFILE"
