# OmniCorp Cloud Security and Infrastructure Policy

## AWS IAM and Authentication
This section details OmniCorp's policies for AWS Identity and Access Management (IAM). All human and machine identities must adhere to these policies.

### IAM Policy Requirements
- **MFA Enforcement**: Multi-Factor Authentication (MFA) is strictly required for all IAM users and root accounts. Any account without MFA active for 24 hours is automatically disabled by the automated compliance engine (OmniGuard-IAM).
- **Least Privilege Access**: Permissions must be explicitly restricted using role-based access control (RBAC). Wildcards (`*`) in the "Action" or "Resource" block of IAM policies are forbidden, except for standard read-only operations.
- **Access Key Rotation**: AWS access keys for IAM users must be rotated every 90 days. The security compliance crawler (OmniGuard-Keys) will flag keys older than 75 days and automatically deactivate keys older than 90 days.

### Cross-Account Access
All access across AWS accounts must be established using IAM roles and AWS STS `AssumeRole` operations. Static credentials (access keys) are prohibited for cross-account operations. The external ID parameter must be configured for third-party integrations.

---

## Data Encryption Policy
All data within OmniCorp's cloud environments must be encrypted both in transit and at rest.

### KMS Key Management
- **Customer Managed Keys (CMKs)**: All business-critical and customer-identifiable databases must use Customer Managed Keys (CMKs) created via AWS KMS. Default AWS Managed Keys are not sufficient for confidential data.
- **Key Rotation**: CMKs must have automatic annual rotation enabled.
- **Encryption Algorithm**: For databases (including RDS and DynamoDB), AES-256 (via the `aws/kms` default or CMK equivalent) is the mandatory minimum standard.
- **KMS Policy Permissions**: KMS key policies must restrict access solely to the specific service roles requiring key operations. General administrative roles should not have permission to decrypt data keys.

### Transport Layer Security
All endpoints exposed to the public internet must use TLS version 1.3. TLS 1.2 is permitted only as a fallback for legacy clients with explicit approval from the Security Review Board (SRB). TLS 1.1 and 1.0 are entirely blocked.

---

## VPC and Network Architecture
OmniCorp enforces strict network segregation across all public cloud environments.

### Subnet Segregation
- **Public Subnets**: Reserved exclusively for Internet Gateways, NAT Gateways, and public Application Load Balancers (ALBs). No databases or application servers may reside in public subnets.
- **Private Subnets**: All container instances, compute nodes, and application servers must run in private subnets.
- **Database Subnets**: Databases must run in isolated subnets with no route table path to the Internet Gateway or NAT Gateway. They must communicate exclusively via VPC Endpoints or specific application private links.

### VPC Flow Logs
VPC Flow Logs must be enabled for all active Virtual Private Clouds. Logs must be streamed directly to CloudWatch Logs or an S3 bucket dedicated to compliance archiving (`omnicorp-security-logs-archive`) with a retention period of 365 days.
