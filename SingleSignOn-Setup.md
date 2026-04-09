# Single Sign-On (SSO) Setup — Microsoft Entra ID ↔ Veeva Vault

This guide walks through configuring SAML 2.0 Single Sign-On between **Microsoft Entra ID** (formerly Azure Active Directory) and **Veeva Vault**. Once configured, users authenticate once through Entra ID and are seamlessly signed into Veeva Vault without entering separate credentials.

SSO is critical for the Veeva Vault Copilot Connector because it enables **Federated ID-based ACL mapping** — the connector uses the Federated ID stored on each Vault user to resolve their Entra ID identity, which is then applied as permissions on Microsoft Graph external items.

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Architecture](#architecture)
- [Step 1: Register Veeva Vault as an Enterprise Application in Entra ID](#step-1-register-veeva-vault-as-an-enterprise-application-in-entra-id)
- [Step 2: Configure SAML SSO in Entra ID](#step-2-configure-saml-sso-in-entra-id)
- [Step 3: Download Entra ID IdP Metadata](#step-3-download-entra-id-idp-metadata)
- [Step 4: Create a SAML Profile in Veeva Vault](#step-4-create-a-saml-profile-in-veeva-vault)
- [Step 5: Import IdP Metadata into Vault](#step-5-import-idp-metadata-into-vault)
- [Step 6: Configure the SSO Security Policy in Vault](#step-6-configure-the-sso-security-policy-in-vault)
- [Step 7: Provision Users for SSO](#step-7-provision-users-for-sso)
- [Step 8: Test the SSO Connection](#step-8-test-the-sso-connection)
- [Connector ACL Integration](#connector-acl-integration)
- [OAuth 2.0 / OpenID Connect Alternative](#oauth-20--openid-connect-alternative)
- [Troubleshooting](#troubleshooting)

---

## Overview

| Component | Role |
|-----------|------|
| **Microsoft Entra ID** | Identity Provider (IdP) — authenticates users and issues SAML assertions |
| **Veeva Vault** | Service Provider (SP) — consumes SAML assertions to authenticate users |
| **SAML 2.0** | Federation protocol used between Entra ID and Vault |
| **Federated ID** | The Entra ID user identifier stored on each Vault user profile, used by the connector for ACL mapping |

### Why SSO Matters for the Connector

The Veeva Vault Copilot Connector maps Vault document permissions to Microsoft Graph ACLs. When SSO is configured with **Federated ID** mapping, each Vault user has an Entra ID-resolvable identifier (typically the user's UPN or Object ID). This allows the connector to:

1. Read the Vault document ACL (which users/groups have access)
2. Resolve each Vault user's Federated ID to their Entra ID identity
3. Apply matching ACLs on the Microsoft Graph external item
4. Ensure users only see Vault content they are authorized to access in Copilot

Without SSO and Federated IDs, the connector falls back to email-based matching, which is less reliable and may not resolve all users correctly.

---

## Prerequisites

### Microsoft Side
- **Microsoft Entra ID** tenant (P1 or P2 license recommended for conditional access)
- **Cloud Application Administrator** or **Global Administrator** role in Entra ID
- Access to the [Microsoft Entra admin center](https://entra.microsoft.com)

### Veeva Side
- **Domain Admin** access to the Veeva Vault domain
- Security profile with **Admin: Domain Administration: SSO Settings: Read** and **Edit** permissions
- Knowledge of your Vault DNS (e.g., `yourcompany.veevavault.com`)
- Access to **Admin > Settings > SAML Profiles** in Vault

---

## Architecture

```
┌──────────────────┐         SAML 2.0          ┌──────────────────┐
│                  │  ◄───────────────────────► │                  │
│  Microsoft       │    Authentication Flow     │  Veeva Vault     │
│  Entra ID        │                            │  (SP)            │
│  (IdP)           │    1. User requests Vault  │                  │
│                  │    2. Vault redirects to    │  PromoMats       │
│  • Users         │       Entra ID             │  QualityDocs     │
│  • Groups        │    3. User authenticates   │  RIM             │
│  • SAML Config   │    4. SAML assertion sent  │                  │
│  • Certificates  │       back to Vault        │  • SAML Profile  │
│                  │    5. Vault grants access   │  • Security      │
│                  │                            │    Policy         │
└──────────────────┘                            │  • Federated ID  │
                                                └──────────────────┘
                                                        │
                                                        │ ACL Resolution
                                                        ▼
                                                ┌──────────────────┐
                                                │  Copilot         │
                                                │  Connector       │
                                                │                  │
                                                │  Reads Vault ACL │
                                                │  → Maps to       │
                                                │    Entra ID      │
                                                │  → Applies to    │
                                                │    Graph Items   │
                                                └──────────────────┘
```

---

## Step 1: Register Veeva Vault as an Enterprise Application in Entra ID

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com).
2. Navigate to **Identity > Applications > Enterprise applications**.
3. Click **+ New application**.
4. Click **+ Create your own application**.
5. Enter a name: `Veeva Vault SSO` (or your preferred name).
6. Select **Integrate any other application you don't find in the gallery (Non-gallery)**.
7. Click **Create**.

---

## Step 2: Configure SAML SSO in Entra ID

1. In the newly created enterprise application, navigate to **Single sign-on** in the left menu.
2. Select **SAML** as the single sign-on method.
3. In the **Basic SAML Configuration** section, click **Edit** and enter:

   | Field | Value |
   |-------|-------|
   | **Identifier (Entity ID)** | `https://login.veevavault.com/auth/saml/sp/<your-vault-domain>` — This must match the **SP Entity ID** value shown in your Vault SAML Profile. Check Vault first. |
   | **Reply URL (ACS URL)** | `https://login.veevavault.com/auth/saml/consumer` — This is the **Vault SSO Login URL** shown in the Vault SAML Profile settings. |
   | **Sign-on URL** | `https://<your-vault-dns>.veevavault.com/ui/` |
   | **Relay State** | Leave blank (Vault handles deep-linking) |
   | **Logout URL** | Optional: `https://<your-vault-dns>.veevavault.com/ui/#logout` |

   > **Note:** The exact SP Entity ID and ACS URL are displayed in your Vault SAML Profile once created. Complete [Step 4](#step-4-create-a-saml-profile-in-veeva-vault) first if you need these values.

4. Click **Save**.

5. In the **Attributes & Claims** section, click **Edit** and configure:

   | Claim Name | Value | Purpose |
   |-----------|-------|---------|
   | `uid` | `user.objectid` or `user.userprincipalname` | **Required.** This is the Federated ID sent to Vault. Choose based on your SAML User ID Type preference. |
   | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | `user.mail` | Email address (optional but recommended) |
   | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` | `user.givenname` | First name (optional) |
   | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname` | `user.surname` | Last name (optional) |

   **Critical Decision — SAML User ID Type:**
   - If you choose **Federated ID** in Vault (recommended): Set the `uid` claim to `user.objectid` (the Entra ID Object ID GUID). This is the most reliable identifier and is what the connector uses for fast ACL resolution.
   - If you choose **Vault User Name** in Vault: Set the `uid` claim to the value matching Vault usernames (typically `user.userprincipalname`).

   > **Recommendation:** Use **Federated ID** with `user.objectid`. This gives the connector a stable, globally unique identifier for each user that never changes even if the user's email or UPN changes.

6. Click **Save**.

---

## Step 3: Download Entra ID IdP Metadata

1. Still in the enterprise application's **SAML-based Sign-on** page, scroll to **Section 3: SAML Certificates**.
2. Download the **Federation Metadata XML** file. You will upload this to Vault in the next step.
3. Also note (or copy) the following values from **Section 4: Set up Veeva Vault SSO**:
   - **Login URL** — This is the Identity Provider Login URL for Vault
   - **Microsoft Entra Identifier** — This is the IdP Entity ID
   - **Logout URL** — This is the Identity Provider Logout URL

---

## Step 4: Create a SAML Profile in Veeva Vault

1. Log in to your Veeva Vault as a **Domain Admin**.
2. Navigate to **Admin > Settings > SAML Profiles**.
3. Click **Create**.
4. Select **Single Sign-on Profile**.
5. Enter the following:

   | Field | Value |
   |-------|-------|
   | **Label** | `Microsoft Entra ID SSO` |
   | **Name** | `microsoft_entra_id_sso` |
   | **Status** | Leave as **Inactive** (activate after testing) |
   | **Description** | `SAML 2.0 SSO with Microsoft Entra ID for M365 Copilot integration` |
   | **SAML Version** | `2.0` |
   | **SAML User ID Type** | `Federated ID` (recommended) or `Vault User Name` |
   | **SP Entity ID** | Auto-generated by Vault (note this value for Entra ID configuration) |

6. Click **Save** to create the profile (you'll configure IdP details in the next step).
7. Note the **Vault SSO Login URL** (ACS URL) displayed at the top — you may need to update this in your Entra ID SAML configuration.

---

## Step 5: Import IdP Metadata into Vault

1. Open the SAML Profile created in Step 4.
2. From the **Actions** menu, select **Import IdP Metadata**.
3. Select **Upload IdP Metadata** and choose the Federation Metadata XML file downloaded from Entra ID in Step 3.
4. Click **Continue**. Vault validates the XML and populates:
   - **Identity Provider Certificate** — Entra ID's signing certificate
   - **Identity Provider Login URL** — Entra ID's SAML endpoint
   - **Identity Provider Logout URL** — Entra ID's logout endpoint
5. Verify all values are populated correctly.
6. Set **SP-Initiated Request Binding** to **HTTP Redirect** (recommended for Entra ID).
7. Set **Signature and Digest Algorithm** to **SHA-256** (recommended).
8. Click **Save**.

**Alternatively**, if you prefer manual configuration instead of metadata import:

| Vault Field | Value from Entra ID |
|-------------|---------------------|
| **Identity Provider Login URL** | Login URL from Entra ID SAML setup |
| **Identity Provider Logout URL** | Logout URL from Entra ID SAML setup |
| **Identity Provider Certificate** | Download Certificate (Base64) from Entra ID SAML Certificates section and upload |
| **SP-Initiated Request URL** | Same as Identity Provider Login URL |

---

## Step 6: Configure the SSO Security Policy in Vault

1. Navigate to **Admin > Settings > Security Policies**.
2. Either create a new policy or edit an existing one:
   - Click **Create** to create a new policy, or select an existing policy and click **Edit**.
3. Set **Authentication Type** to **Single Sign-on**.
4. Under **Single Sign-on Profile**, select the SAML profile created in Step 4 (`Microsoft Entra ID SSO`).
5. Configure additional policy settings:

   | Setting | Recommended Value |
   |---------|-------------------|
   | **Password Policy** | Set minimum requirements (still needed for API access fallback) |
   | **Session Duration** | 60 minutes (or per your security requirements) |
   | **Inactivity Timeout** | 20 minutes |
   | **API Session Duration** | 48 hours maximum (used by the connector) |

6. Click **Save**.

---

## Step 7: Provision Users for SSO

For each user who should use SSO:

1. Navigate to **Admin > Users & Groups > Users** in Vault.
2. Select the user and click **Edit**.
3. Set:
   - **Security Policy** — Select the SSO security policy created in Step 6
   - **Federated ID** — Enter the user's Entra ID Object ID (GUID format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
4. Click **Save**.

### Bulk User Provisioning

For large user populations, use the Vault User API to bulk-update Federated IDs:

```bash
# Export users from Entra ID (PowerShell)
Connect-MgGraph -Scopes "User.Read.All"
Get-MgUser -All | Select-Object Id, UserPrincipalName, Mail | Export-Csv -Path "entra_users.csv"

# Update Vault users via API
curl -X PUT -H "Authorization: {SESSION_ID}" \
  -H "Content-Type: text/csv" \
  --data-binary @vault_user_updates.csv \
  "https://{vault-dns}/api/v25.3/objects/users"
```

The CSV should map Entra ID Object IDs to Vault users in the `federated_id__v` field.

### SCIM Provisioning (Optional)

Veeva Vault supports SCIM 2.0 for automated user provisioning. With SCIM, user creation, updates, and deactivation in Entra ID automatically propagate to Vault. This ensures Federated IDs are always current.

To configure SCIM:
1. In the Entra ID enterprise application, go to **Provisioning**.
2. Set **Provisioning Mode** to **Automatic**.
3. Enter the Vault SCIM endpoint URL and authentication token.
4. Map Entra ID attributes to Vault user fields, including the Federated ID.
5. Enable provisioning.

> See the [Veeva Vault SCIM documentation](https://platform.veevavault.help/en/lr/52437/) for detailed configuration.

---

## Step 8: Test the SSO Connection

### SP-Initiated Test (From Vault)

1. Open a private/incognito browser window.
2. Navigate to `https://<your-vault-dns>.veevavault.com/ui/`.
3. You should be redirected to the Entra ID login page.
4. Sign in with a test user's Entra ID credentials.
5. After successful authentication, you should be redirected back to Vault and signed in.

### IdP-Initiated Test (From Entra ID)

1. Sign in to [myapps.microsoft.com](https://myapps.microsoft.com).
2. Click the **Veeva Vault SSO** application tile.
3. You should be seamlessly signed into Vault.

### Entra ID Test Button

1. In the Entra ID enterprise application, go to **Single sign-on**.
2. Click **Test this application**.
3. Select a test user and click **Test sign in**.
4. Verify successful authentication.

### Activate the Profile

Once testing is successful:
1. Go to **Admin > Settings > SAML Profiles** in Vault.
2. Edit the SAML profile and set **Status** to **Active**.
3. Click **Save**.

---

## Connector ACL Integration

With SSO configured and Federated IDs populated, the connector's ACL mapping works as follows:

```
Vault Document ACL                    Microsoft Graph ACL
─────────────────                    ──────────────────
User: jsmith                         Entra ID User: 
  Federated ID: abc-123-def     →     Object ID: abc-123-def
  Role: Viewer                        AccessType: Grant

Group: Medical Affairs               Entra ID Group:
  Vault Group ID: 12345         →     Matched by name/email
  Role: Editor                        OR External Group synced

Lifecycle State: Approved             Filtered by View permission
  Viewer Role: Has View         →     Only users with View 
  Editor Role: Has View               permission get ACL grant
  Owner Role: Has View
```

### Federated ID Fast Path

When a Vault user has a Federated ID that is a valid GUID (Entra ID Object ID), the connector uses it directly without making additional Graph API calls to resolve the user. This is significantly faster than email-based lookup and is the recommended configuration.

### Ensuring Complete Coverage

To verify that all Vault users have Federated IDs for connector ACL mapping:

```sql
-- VQL query to find users without Federated IDs
SELECT id, user_name__v, user_email__v, federated_id__v 
FROM user__sys 
WHERE federated_id__v = '' AND status__v = 'active__v'
```

Users without Federated IDs will fall back to email-based Entra ID resolution, which is slower and may fail for users whose Vault email differs from their Entra ID email.

---

## OAuth 2.0 / OpenID Connect Alternative

Veeva Vault also supports OAuth 2.0 / OpenID Connect (OIDC) as an alternative to SAML. This can be configured alongside or instead of SAML.

### When to Use OIDC Instead of SAML

- Your organization prefers OIDC over SAML
- You want token-based authentication with shorter token lifetimes
- You need API-level authentication integration beyond browser SSO

### OIDC Configuration (High-Level)

1. In Vault: **Admin > Settings > OAuth 2.0 / OpenID Connect Profiles**
2. Create a new profile with the Entra ID OIDC discovery URL:
   `https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration`
3. Configure the client ID and authorization settings
4. Map claims to Vault user identifiers

> See the [Veeva Vault OIDC documentation](https://platform.veevavault.help/en/lr/43329/) for detailed setup.

---

## Troubleshooting

### Common Issues

| Issue | Cause | Resolution |
|-------|-------|------------|
| **"Invalid SAML Response"** in Vault | Certificate mismatch | Re-download the Entra ID Federation Metadata XML and re-import into Vault SAML Profile |
| **User not found** after SAML assertion | Federated ID mismatch | Verify the `uid` claim in Entra ID matches the Federated ID (or Vault username) exactly |
| **"INSUFFICIENT_ACCESS"** after SSO login | User lacks API access | Grant the API Access permission in the user's Vault security profile |
| **Redirect loop** between Entra ID and Vault | ACS URL mismatch | Verify the Reply URL in Entra ID matches the Vault SSO Login URL exactly |
| **Certificate expiration** | Entra ID signing certificate expired | Download new certificate from Entra ID and update in Vault SAML Profile |
| **Users can't sign in after certificate rollover** | Old certificate still active in Vault | Import new IdP metadata or manually update the IdP certificate in Vault |
| **Connector can't resolve user** | Missing Federated ID | Run VQL query to find users without `federated_id__v` and populate with Entra ID Object IDs |

### Diagnostic Checklist

1. ✅ Entra ID Enterprise Application created with SAML SSO
2. ✅ `uid` claim configured to send correct identifier
3. ✅ Vault SAML Profile created with correct IdP metadata
4. ✅ SP Entity ID in Vault matches Identifier in Entra ID
5. ✅ ACS URL in Vault matches Reply URL in Entra ID
6. ✅ Vault SSO Security Policy created and assigned to users
7. ✅ Federated IDs populated on all Vault user profiles
8. ✅ Test user can successfully authenticate via SSO
9. ✅ SAML Profile activated in Vault
10. ✅ Connector ACL mapping resolves users via Federated ID

### Vault SAML Debug Logging

Vault provides SAML debug logging for troubleshooting:
1. Navigate to **Admin > Settings > SAML Profiles**.
2. Open the profile and click **Actions > View SAML Log**.
3. Review the log entries for authentication attempts, including SAML requests and responses.

### Entra ID Sign-in Logs

1. In the Entra admin center, navigate to **Identity > Monitoring & health > Sign-in logs**.
2. Filter by the Veeva Vault enterprise application.
3. Review successful and failed sign-in attempts.
4. Click on a specific entry to see the SAML request/response details and any error codes.
