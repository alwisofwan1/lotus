---
name: aws
description: Operate AWS resources — S3, EC2, Lambda, IAM, CloudWatch, and more — via the `aws` CLI. Use whenever the task involves AWS infrastructure, deployments, or resource inspection.
---

# AWS (via the `aws` CLI)

Use the `aws` CLI. Credentials come from `~/.aws/credentials`, an instance role,
or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` in the environment.
**Always verify identity first**: `aws sts get-caller-identity`.

## Common operations
- **Identity / config**: `aws sts get-caller-identity`, `aws configure list`.
- **S3**: `aws s3 ls`, `aws s3 cp <src> <dst>`, `aws s3 sync <src> <dst>`.
- **EC2**: `aws ec2 describe-instances`, `aws ec2 start-instances --instance-ids …`.
- **Lambda**: `aws lambda list-functions`, `aws lambda invoke --function-name … out.json`,
  `aws lambda update-function-code …`.
- **Logs**: `aws logs tail <log-group> --follow`.
- Add `--output json` and pipe through `jq` for anything you need to parse.

## Rules
- **Inspect before mutate**: run `describe-*` / `ls` to confirm the target before any
  state-changing call.
- **Never** run destructive ops (`terminate-instances`, `s3 rb`, `delete-*`,
  `update-function-code` on prod) without explicit confirmation in the task.
- Respect the configured/region the task specifies — do not assume a default region.
- Never print full secret keys or tokens.
