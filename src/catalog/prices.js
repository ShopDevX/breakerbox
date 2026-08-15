/**
 * Approximate on-demand list prices, USD per hour, us-east-1 / us-central1 / eastus.
 *
 * These are guardrail inputs, not an invoice. They are intentionally rounded and
 * ignore region, reservations, savings plans, spot and committed-use discounts.
 * Override anything here via `priceOverrides` in breakerbox.config.json.
 */
export const PRICES_UPDATED = '2026-08';

export const EC2 = {
  't2.micro': 0.0116, 't2.small': 0.023, 't2.medium': 0.0464,
  't3.nano': 0.0052, 't3.micro': 0.0104, 't3.small': 0.0208, 't3.medium': 0.0416,
  't3.large': 0.0832, 't3.xlarge': 0.1664, 't3.2xlarge': 0.3328,
  't4g.micro': 0.0084, 't4g.small': 0.0168, 't4g.medium': 0.0336,
  'm5.large': 0.096, 'm5.xlarge': 0.192, 'm5.2xlarge': 0.384, 'm5.4xlarge': 0.768,
  'm5.8xlarge': 1.536, 'm5.12xlarge': 2.304, 'm5.16xlarge': 3.072, 'm5.24xlarge': 4.608,
  'm6i.large': 0.096, 'm6i.xlarge': 0.192, 'm6i.4xlarge': 0.768, 'm6i.8xlarge': 1.536,
  'c5.large': 0.085, 'c5.xlarge': 0.17, 'c5.2xlarge': 0.34, 'c5.4xlarge': 0.68,
  'c5.9xlarge': 1.53, 'c5.18xlarge': 3.06,
  'c6i.large': 0.085, 'c6i.xlarge': 0.17, 'c6i.8xlarge': 1.36,
  'r5.large': 0.126, 'r5.xlarge': 0.252, 'r5.2xlarge': 0.504, 'r5.4xlarge': 1.008,
  'r5.12xlarge': 3.024, 'r5.24xlarge': 6.048,
  'x1e.32xlarge': 26.688,
  'g4dn.xlarge': 0.526, 'g4dn.2xlarge': 0.752, 'g4dn.12xlarge': 3.912,
  'g5.xlarge': 1.006, 'g5.12xlarge': 5.672, 'g5.48xlarge': 16.288,
  'p3.2xlarge': 3.06, 'p3.8xlarge': 12.24, 'p3.16xlarge': 24.48,
  'p4d.24xlarge': 32.7726, 'p5.48xlarge': 98.32,
  'inf1.xlarge': 0.228, 'trn1.32xlarge': 21.50,
};

export const RDS = {
  'db.t3.micro': 0.017, 'db.t3.small': 0.034, 'db.t3.medium': 0.068, 'db.t3.large': 0.136,
  'db.t4g.micro': 0.016, 'db.t4g.medium': 0.065,
  'db.m5.large': 0.171, 'db.m5.xlarge': 0.342, 'db.m5.2xlarge': 0.684, 'db.m5.4xlarge': 1.368,
  'db.r5.large': 0.24, 'db.r5.xlarge': 0.48, 'db.r5.4xlarge': 1.92, 'db.r5.12xlarge': 5.76,
};

export const ELASTICACHE = {
  'cache.t3.micro': 0.017, 'cache.t3.small': 0.034, 'cache.t3.medium': 0.068,
  'cache.m5.large': 0.156, 'cache.m5.xlarge': 0.311, 'cache.r5.large': 0.216,
  'cache.r5.4xlarge': 1.729,
};

export const REDSHIFT = {
  'dc2.large': 0.25, 'dc2.8xlarge': 4.80, 'ra3.xlplus': 1.086, 'ra3.4xlarge': 3.26,
  'ra3.16xlarge': 13.04,
};

export const SAGEMAKER = {
  'ml.t3.medium': 0.05, 'ml.t3.xlarge': 0.20, 'ml.m5.xlarge': 0.23, 'ml.m5.4xlarge': 0.922,
  'ml.c5.9xlarge': 1.836, 'ml.g4dn.xlarge': 0.736, 'ml.g5.12xlarge': 7.09,
  'ml.p3.2xlarge': 3.825, 'ml.p3.16xlarge': 28.152, 'ml.p4d.24xlarge': 37.688,
};

export const GCE = {
  'e2-micro': 0.008, 'e2-small': 0.017, 'e2-medium': 0.033,
  'e2-standard-2': 0.067, 'e2-standard-4': 0.134, 'e2-standard-8': 0.268,
  'e2-standard-16': 0.536, 'e2-standard-32': 1.072,
  'n1-standard-1': 0.0475, 'n1-standard-2': 0.095, 'n1-standard-4': 0.19,
  'n1-standard-8': 0.38, 'n1-standard-16': 0.76,
  'n2-standard-2': 0.097, 'n2-standard-4': 0.194, 'n2-standard-8': 0.388,
  'n2-standard-16': 0.776, 'n2-standard-32': 1.553,
  'c2-standard-4': 0.2088, 'c2-standard-16': 0.8352,
  'a2-highgpu-1g': 3.67, 'a2-highgpu-8g': 29.39, 'a2-ultragpu-8g': 40.55,
  'a3-highgpu-8g': 87.90,
  'g2-standard-4': 0.71, 'g2-standard-48': 5.95,
};

export const CLOUD_SQL = {
  'db-f1-micro': 0.015, 'db-g1-small': 0.05,
  'db-n1-standard-1': 0.0965, 'db-n1-standard-2': 0.193, 'db-n1-standard-4': 0.386,
  'db-n1-standard-8': 0.772, 'db-n1-highmem-4': 0.5104,
};

export const AZURE_VM = {
  'Standard_B1s': 0.0104, 'Standard_B2s': 0.0416, 'Standard_B4ms': 0.166,
  'Standard_D2s_v3': 0.096, 'Standard_D4s_v3': 0.192, 'Standard_D8s_v3': 0.384,
  'Standard_D16s_v3': 0.768, 'Standard_D32s_v3': 1.536,
  'Standard_E4s_v3': 0.252, 'Standard_E16s_v3': 1.008,
  'Standard_F8s_v2': 0.338,
  'Standard_NC6': 0.90, 'Standard_NC24': 3.60, 'Standard_ND40rs_v2': 22.032,
  'Standard_NC24ads_A100_v4': 3.673,
};

/** Flat hourly costs for managed control planes and network appliances. */
export const FIXED = {
  'aws.eks.cluster': 0.10,
  'aws.nat-gateway': 0.045,
  'aws.alb': 0.0225,
  'aws.transit-gateway': 0.05,
  'aws.global-accelerator': 0.025,
  'gcp.gke.cluster': 0.10,
  'azure.aks.cluster': 0.0,
  'aws.msk.broker': 0.21,
  'aws.opensearch.node': 0.135,
  'aws.documentdb.instance': 0.277,
  'aws.eip.idle': 0.005,
};
