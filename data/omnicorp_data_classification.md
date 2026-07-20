# OmniCorp Data Classification and Lifecycle Policy

## Classification Hierarchy
OmniCorp classifies its data assets into four categories based on the risk of unauthorized disclosure.

### 1. Restricted (Confidential-Restricted)
- **Definition**: Highly sensitive data that, if compromised, would cause severe financial, legal, or reputational damage. Examples include customer personally identifiable information (PII), payment card details (PCI), proprietary source code, and trade secrets.
- **Handling Rules**:
  - **Storage**: Must be encrypted at rest using CMK keys.
  - **Access**: Strictly restricted using access control lists (ACLs) and dual-authorization mechanisms where possible.
  - **Transmission**: Must be encrypted in transit using TLS 1.3.

### 2. Confidential (Confidential-Internal)
- **Definition**: Information intended solely for internal employees and approved contractors. Examples include internal org charts, strategic roadmaps, project timelines, and policy drafts.
- **Handling Rules**:
  - **Storage**: Allowed on internal network drives and MDM-compliant corporate endpoints.
  - **Access**: Restricted to active employees with a valid enterprise login.

### 3. Public
- **Definition**: Information cleared for general public access. Examples include marketing collateral, published white papers, and corporate press releases.
- **Handling Rules**: No encryption requirements, but integrity must be protected to prevent unauthorized modification of external-facing documentation.

---

## Data Retention and Destruction
To minimize data footprint and mitigate exposure risks, OmniCorp enforces specific lifecycle policies.

### Retention Schedule
- **Financial Records**: Retained for 7 years in cold storage (AWS S3 Glacier with Vault Lock active).
- **Employee Records**: Retained for 5 years after termination.
- **VPC Flow Logs**: Retained for 1 year (365 days) in the `omnicorp-security-logs-archive` S3 bucket.
- **System Activity Logs**: Retained for 90 days.

### Destruction Methods
- **Cloud Assets**: Must be securely overwritten and deleted from all active and backup volumes. For KMS-encrypted buckets, de-provisioning the specific KMS key is an acceptable method for cryptographic erasure.
- **Physical Media**: SSDs, HDDs, and mobile storage devices must be physically shredded or degaussed by certified hardware destruction vendors.
