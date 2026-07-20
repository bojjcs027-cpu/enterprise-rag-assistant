# OmniCorp Remote Work and Device Security Policy

## Remote Access Protocol
This document outlines security requirements for employees accessing OmniCorp systems from remote locations.

### Secure Connection Requirements
- **Corporate VPN**: Access to any internal service (code repositories, internal databases, HR dashboards) is restricted to the OmniCorp Unified VPN. Direct access over the public internet is disabled.
- **VPN Session Limits**: VPN sessions automatically terminate after 12 hours of continuous connection. Re-authentication with MFA is mandatory to establish a new session.
- **Split Tunneling**: Split tunneling is disabled on all corporate VPN profiles. All internet traffic from a connected device must route through the OmniCorp Security Gateway for inspection and threat analysis.

### Device Compliance Checks
Before establishing a VPN connection, the client device must pass automated device health checks verifying:
1. **OS Patch Version**: The OS must be running a patch release no older than 30 days.
2. **Antivirus Status**: The endpoint protection agent (OmniShield-Agent) must be active and have signature databases updated within the last 24 hours.
3. **Firewall Status**: The local system firewall must be turned on.

---

## Device Asset Management
All employees are issued corporate devices. Use of personal devices (BYOD) for corporate operations is subject to strict limits.

### Approved Devices
- **Corporate Laptops**: Only hardware assets pre-configured and registered in the OmniCorp Active Directory are authorized.
- **BYOD Policy**: Access to corporate email and Slack via personal mobile devices is permitted only if the device is enrolled in the Mobile Device Management (MDM) platform (OmniMDM). MDM enforces remote-wipe capabilities, disk encryption, and a 6-digit PIN lock.

### Loss and Theft Reporting
If a corporate laptop or MDM-enrolled personal device is lost or stolen, the employee must report the incident to the Security Operations Center (SOC) within 2 hours. The SOC will execute a remote wipe command within 15 minutes of receiving the report.
