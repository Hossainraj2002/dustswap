export interface PublicDelivery {
  canonical: URL;
  delivery: URL;
}

export interface PublicDeliveryRequest {
  method: string;
  url: string | URL;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface PublicDeliveryRedirect {
  status: 307;
  location: string;
  headers: Readonly<{ "cache-control": string; vary: string }>;
}

export function isCid(value: string): boolean;
export function publicDeliveryConfig(canonical: string | undefined, delivery: string | undefined): PublicDelivery | undefined;
export function publicDeliveryRedirectFor(config: PublicDelivery | undefined, request: PublicDeliveryRequest): PublicDeliveryRedirect | undefined;
