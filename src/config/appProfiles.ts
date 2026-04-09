/**
 * Application Profiles — Defines app-specific configuration for each Veeva Vault application.
 *
 * Each profile specifies:
 * - Connector identity (ID, name, description)
 * - Known object types to index
 * - App-specific schema properties
 * - Declarative agent configuration
 */

export type VaultApplication = "promomats" | "qualitydocs" | "rim";

export interface AppProfile {
  application: VaultApplication;
  connectorId: string;
  connectorName: string;
  connectorDescription: string;
  knownObjectTypes: string[];
  schemaExtensions: SchemaExtension[];
  agentName: string;
  agentDescription: string;
}

export interface SchemaExtension {
  name: string;
  type: "String" | "DateTime" | "Boolean" | "Int64" | "StringCollection";
  isQueryable: boolean;
  isRetrievable: boolean;
  isSearchable: boolean;
  isRefinable: boolean;
  description: string;
}

const PROMOMATS_PROFILE: AppProfile = {
  application: "promomats",
  connectorId: "veevaPromoMats",
  connectorName: "Veeva PromoMats Enhanced",
  connectorDescription:
    "Enhanced Veeva PromoMats connector with incremental crawl via Direct Data API. Indexes promotional content, claims, key messages, and brand assets.",
  knownObjectTypes: [
    "product__v",
    "country__v",
    "key_message__v",
    "campaign__v",
    "indication__v",
    "therapeutic_area__v",
    "material__v",
    "claim__v",
    "audience__v",
    "channel__v",
  ],
  schemaExtensions: [
    ext("keyMessages", "String", true, true, true, false, "Key promotional messages"),
    ext("claim", "String", true, true, true, false, "Associated claim text"),
    ext("audience", "String", true, true, true, true, "Target audience"),
    ext("channel", "String", true, true, true, true, "Distribution channel"),
    ext("mlrStatus", "String", true, true, false, true, "MLR review status"),
    ext("promotionalType", "String", true, true, false, true, "Type of promotional material"),
  ],
  agentName: "Veeva PromoMats",
  agentDescription: "Search and retrieve Veeva PromoMats promotional content, claims, brand assets, and key messages.",
};

const QUALITYDOCS_PROFILE: AppProfile = {
  application: "qualitydocs",
  connectorId: "veevaQualityDocs",
  connectorName: "Veeva QualityDocs Enhanced",
  connectorDescription:
    "Enhanced Veeva QualityDocs connector with incremental crawl via Direct Data API. Indexes SOPs, work instructions, CAPAs, deviations, quality events, and controlled documents.",
  knownObjectTypes: [
    "product__v",
    "country__v",
    "facility__v",
    "quality_event__v",
    "deviation__v",
    "capa__v",
    "complaint__v",
    "change_control__v",
    "audit__v",
    "lab_investigation__v",
    "training_requirement__v",
    "training_assignment__v",
    "document_change_control__v",
    "periodic_review__v",
    "controlled_copy__v",
  ],
  schemaExtensions: [
    ext("effectiveDate", "DateTime", true, true, false, false, "Document effective date"),
    ext("periodicReviewDate", "DateTime", true, true, false, false, "Next periodic review date"),
    ext("trainingRequired", "Boolean", true, true, false, false, "Whether training is required"),
    ext("facility", "String", true, true, true, true, "Owning facility"),
    ext("department", "String", true, true, true, true, "Department"),
    ext("qualityEventType", "String", true, true, false, true, "Quality event type"),
    ext("capaNumber", "String", true, true, true, false, "CAPA reference number"),
    ext("deviationNumber", "String", true, true, true, false, "Deviation reference number"),
    ext("complaintNumber", "String", true, true, true, false, "Complaint reference number"),
    ext("changeControlNumber", "String", true, true, true, false, "Change control reference number"),
    ext("auditType", "String", true, true, false, true, "Audit type (internal/external)"),
  ],
  agentName: "Veeva QualityDocs",
  agentDescription: "Search and retrieve Veeva QualityDocs quality content — SOPs, CAPAs, deviations, complaints, audits, and controlled documents.",
};

const RIM_PROFILE: AppProfile = {
  application: "rim",
  connectorId: "veevaRIM",
  connectorName: "Veeva RIM Enhanced",
  connectorDescription:
    "Enhanced Veeva RIM connector with incremental crawl via Direct Data API. Indexes regulatory submissions, registrations, dossiers, health authority correspondence, and compliance documents.",
  knownObjectTypes: [
    "product__v",
    "country__v",
    "application__v",
    "submission__v",
    "regulatory_objective__v",
    "registration__v",
    "health_authority__v",
    "content_plan__v",
    "content_plan_item__v",
    "active_dossier__v",
    "regulatory_event__v",
    "health_authority_interaction__v",
  ],
  schemaExtensions: [
    ext("applicationNumber", "String", true, true, true, false, "Regulatory application number"),
    ext("submissionType", "String", true, true, false, true, "Submission type"),
    ext("regulatoryObjective", "String", true, true, true, false, "Regulatory objective"),
    ext("registrationStatus", "String", true, true, false, true, "Registration status"),
    ext("healthAuthority", "String", true, true, true, true, "Target health authority"),
    ext("dossierSection", "String", true, true, true, false, "eCTD/dossier section"),
    ext("contentPlanItem", "String", true, true, true, false, "Content plan item reference"),
    ext("marketCountry", "String", true, true, true, true, "Target market/country"),
    ext("submissionDate", "DateTime", true, true, false, false, "Submission date to authority"),
    ext("approvalDate", "DateTime", true, true, false, false, "Health authority approval date"),
  ],
  agentName: "Veeva RIM",
  agentDescription: "Search and retrieve Veeva RIM regulatory content — submissions, registrations, dossiers, health authority correspondence, and compliance documents.",
};

const PROFILES: Record<VaultApplication, AppProfile> = {
  promomats: PROMOMATS_PROFILE,
  qualitydocs: QUALITYDOCS_PROFILE,
  rim: RIM_PROFILE,
};

export function getAppProfile(application: VaultApplication): AppProfile {
  const profile = PROFILES[application];
  if (!profile) {
    throw new Error(
      `Unknown Vault application: '${application}'. Valid options: ${Object.keys(PROFILES).join(", ")}`
    );
  }
  return profile;
}

export function getAllProfiles(): AppProfile[] {
  return Object.values(PROFILES);
}

export function isValidApplication(value: string): value is VaultApplication {
  return value in PROFILES;
}

function ext(
  name: string,
  type: SchemaExtension["type"],
  isQueryable: boolean,
  isRetrievable: boolean,
  isSearchable: boolean,
  isRefinable: boolean,
  description: string
): SchemaExtension {
  return { name, type, isQueryable, isRetrievable, isSearchable, isRefinable, description };
}
