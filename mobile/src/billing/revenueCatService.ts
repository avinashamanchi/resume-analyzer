import type { InstallationIdentityProvider, VerifiedPlanSnapshot } from '../api/planApi';

export type BillingAvailability = 'ready' | 'preview' | 'configuration' | 'error';
export type BillingPlanStatus = 'loading' | 'free' | 'pro_verified' | 'pro_verification_needed';

export type BillingProduct = Readonly<{
  id: string;
  title: string;
  description: string;
  price: string;
  period: string | null;
}>;

export type BillingSnapshot = Readonly<{
  availability: BillingAvailability;
  planStatus: BillingPlanStatus;
  entitlementActive: boolean;
  allowance: VerifiedPlanSnapshot['allowance'] | null;
  verifiedPlan?: VerifiedPlanSnapshot | null;
  products: readonly BillingProduct[];
}>;

type RevenueCatPackage = Readonly<{
  identifier: string;
  packageType: string;
  product: Readonly<{
    identifier: string;
    title: string;
    description: string;
    priceString: string;
    subscriptionPeriod?: string | null;
  }>;
}>;

type RevenueCatCustomerInfo = Readonly<{
  entitlements: Readonly<{
    active: Readonly<Record<string, Readonly<{ isActive?: boolean }>>>;
  }>;
}>;

export type RevenueCatModule = Readonly<{
  configure(options: Readonly<{ apiKey: string; appUserID: string }>): void;
  getAppUserID(): Promise<string>;
  getOfferings(): Promise<Readonly<{
    current: Readonly<{ availablePackages: readonly RevenueCatPackage[] }> | null;
  }>>;
  getCustomerInfo(): Promise<RevenueCatCustomerInfo>;
  purchasePackage(item: RevenueCatPackage): Promise<Readonly<{
    customerInfo: RevenueCatCustomerInfo;
  }>>;
  restorePurchases(): Promise<RevenueCatCustomerInfo>;
  logIn(appUserID: string): Promise<Readonly<{
    customerInfo: RevenueCatCustomerInfo;
    created: boolean;
  }>>;
  logOut(): Promise<RevenueCatCustomerInfo>;
}>;

export type PlanVerifier = Readonly<{
  sync(signal: AbortSignal): Promise<VerifiedPlanSnapshot>;
}>;

export type RevenueCatBillingOptions = Readonly<{
  apiKey: string | undefined;
  entitlementId: string;
  executionEnvironment: string;
  installationTokens: InstallationIdentityProvider;
  planApi: PlanVerifier;
  moduleLoader?: () => RevenueCatModule | Promise<RevenueCatModule>;
  productIds: readonly string[];
  now?: () => number;
}>;

const EMPTY_PRODUCTS: readonly BillingProduct[] = Object.freeze([]);

export class PurchaseCancelledError extends Error {
  constructor() {
    super('Purchase cancelled.');
    this.name = 'PurchaseCancelledError';
  }
}

export class BillingUnavailableError extends Error {
  constructor() {
    super('Purchases are unavailable.');
    this.name = 'BillingUnavailableError';
  }
}

const defaultModuleLoader = async (): Promise<RevenueCatModule> => {
  const loaded = await import('react-native-purchases');
  return loaded.default as unknown as RevenueCatModule;
};

function sdkEntitlementActive(info: RevenueCatCustomerInfo, entitlementId: string): boolean {
  return info.entitlements.active[entitlementId]?.isActive === true;
}

export class RevenueCatBillingService {
  private module: RevenueCatModule | null = null;
  private configuration: Promise<RevenueCatModule> | null = null;
  private readonly packageByProductId = new Map<string, RevenueCatPackage>();
  private products: readonly BillingProduct[] = EMPTY_PRODUCTS;
  private planStatus: BillingPlanStatus = 'loading';
  private entitlementActive = false;
  private allowance: VerifiedPlanSnapshot['allowance'] | null = null;
  private verifiedPlan: VerifiedPlanSnapshot | null = null;
  private sdkShowsPro = false;
  private readonly now: () => number;

  constructor(private readonly options: RevenueCatBillingOptions) {
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<BillingSnapshot> {
    const unavailable = this.unavailableSnapshot();
    if (unavailable !== null) return unavailable;

    try {
      const purchases = await this.getConfiguredModule();
      const [offeringsResult, customerInfoResult, planResult] = await Promise.allSettled([
        purchases.getOfferings(),
        purchases.getCustomerInfo(),
        this.options.planApi.sync(new AbortController().signal),
      ]);
      if (offeringsResult.status === 'fulfilled') this.rememberProducts(offeringsResult.value);
      if (customerInfoResult.status === 'fulfilled') {
        this.sdkShowsPro = sdkEntitlementActive(customerInfoResult.value, this.options.entitlementId);
      }
      if (planResult.status === 'fulfilled') this.applyVerifiedPlan(planResult.value);
      else this.requireVerification();

      return this.snapshot(
        offeringsResult.status === 'fulfilled' && planResult.status === 'fulfilled'
          ? 'ready'
          : 'error',
      );
    } catch {
      this.requireVerification();
      return this.snapshot('error');
    }
  }

  async purchase(productId: string): Promise<BillingSnapshot> {
    const unavailable = this.unavailableSnapshot();
    if (unavailable !== null) throw new BillingUnavailableError();
    const purchases = await this.getConfiguredModule();
    if (this.packageByProductId.size === 0) await this.load();
    const item = this.packageByProductId.get(productId);
    if (!item) throw new BillingUnavailableError();
    let customerInfo: RevenueCatCustomerInfo;
    try {
      customerInfo = (await purchases.purchasePackage(item)).customerInfo;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'userCancelled' in error &&
        error.userCancelled === true
      ) {
        throw new PurchaseCancelledError();
      }
      throw new BillingUnavailableError();
    }
    this.sdkShowsPro = sdkEntitlementActive(customerInfo, this.options.entitlementId);
    return this.refreshVerifiedPlan();
  }

  async restore(): Promise<BillingSnapshot> {
    const unavailable = this.unavailableSnapshot();
    if (unavailable !== null) throw new BillingUnavailableError();
    let customerInfo: RevenueCatCustomerInfo;
    try {
      const purchases = await this.getConfiguredModule();
      customerInfo = await purchases.restorePurchases();
    } catch {
      throw new BillingUnavailableError();
    }
    this.sdkShowsPro = sdkEntitlementActive(customerInfo, this.options.entitlementId);
    return this.refreshVerifiedPlan();
  }

  async logIn(appUserId: string): Promise<BillingSnapshot> {
    if (!/^rai_account_[A-Za-z0-9_-]{43}$/.test(appUserId)) {
      throw new BillingUnavailableError();
    }
    try {
      const purchases = await this.getConfiguredModule();
      const result = await purchases.logIn(appUserId);
      if (await purchases.getAppUserID() !== appUserId) throw new Error('RevenueCat identity mismatch');
      this.sdkShowsPro = sdkEntitlementActive(result.customerInfo, this.options.entitlementId);
      return this.refreshVerifiedPlan();
    } catch {
      this.requireVerification();
      throw new BillingUnavailableError();
    }
  }

  async linkAccount(
    appUserId: string,
    verify: () => Promise<VerifiedPlanSnapshot>,
  ): Promise<BillingSnapshot> {
    if (!/^rai_account_[A-Za-z0-9_-]{43}$/.test(appUserId)) {
      throw new BillingUnavailableError();
    }
    let customerInfo: RevenueCatCustomerInfo;
    try {
      const purchases = await this.getConfiguredModule();
      const login = await purchases.logIn(appUserId);
      if (await purchases.getAppUserID() !== appUserId) throw new Error('RevenueCat identity mismatch');
      customerInfo = await purchases.restorePurchases();
      this.sdkShowsPro =
        sdkEntitlementActive(login.customerInfo, this.options.entitlementId) ||
        sdkEntitlementActive(customerInfo, this.options.entitlementId);
    } catch {
      this.requireVerification();
      throw new BillingUnavailableError();
    }
    try {
      this.applyVerifiedPlan(await verify());
      return this.snapshot('ready');
    } catch {
      this.requireVerification();
      return this.snapshot('error');
    }
  }

  async logOut(): Promise<BillingSnapshot> {
    try {
      const purchases = await this.getConfiguredModule();
      const customerInfo = await purchases.logOut();
      this.sdkShowsPro = sdkEntitlementActive(customerInfo, this.options.entitlementId);
      return this.refreshVerifiedPlan();
    } catch {
      this.requireVerification();
      throw new BillingUnavailableError();
    }
  }

  private unavailableSnapshot(): BillingSnapshot | null {
    if (this.options.executionEnvironment === 'storeClient') {
      return {
        availability: 'preview',
        planStatus: 'free',
        entitlementActive: false,
        allowance: null,
        verifiedPlan: null,
        products: EMPTY_PRODUCTS,
      };
    }
    if (!this.options.apiKey?.trim()) {
      return {
        availability: 'configuration',
        planStatus: 'free',
        entitlementActive: false,
        allowance: null,
        verifiedPlan: null,
        products: EMPTY_PRODUCTS,
      };
    }
    return null;
  }

  private async getConfiguredModule(): Promise<RevenueCatModule> {
    if (this.configuration !== null) return this.configuration;
    this.configuration = this.configureModule();
    try {
      return await this.configuration;
    } catch (error) {
      this.configuration = null;
      throw error;
    }
  }

  private async configureModule(): Promise<RevenueCatModule> {
    this.module ??= await (this.options.moduleLoader ?? defaultModuleLoader)();
    const identity = await this.options.installationTokens.getOrIssueIdentity(
      new AbortController().signal,
    );
    this.module.configure({
      apiKey: this.options.apiKey as string,
      appUserID: identity.revenueCatAppUserId,
    });
    if (await this.module.getAppUserID() !== identity.revenueCatAppUserId) {
      throw new Error('RevenueCat identity mismatch');
    }
    return this.module;
  }

  private rememberProducts(offerings: Awaited<ReturnType<RevenueCatModule['getOfferings']>>): void {
    this.packageByProductId.clear();
    const allowed = new Set(this.options.productIds);
    for (const item of offerings.current?.availablePackages ?? []) {
      if (allowed.has(item.product.identifier)) this.packageByProductId.set(item.product.identifier, item);
    }
    this.products = this.options.productIds.flatMap(productId => {
      const item = this.packageByProductId.get(productId);
      return item ? [this.mapProduct(item)] : [];
    });
  }

  private mapProduct(item: RevenueCatPackage): BillingProduct {
    return {
      id: item.product.identifier,
      title: item.product.title,
      description: item.product.description,
      price: item.product.priceString,
      period: item.product.subscriptionPeriod ?? null,
    };
  }

  private applyVerifiedPlan(plan: VerifiedPlanSnapshot): void {
    const verifiedUntil = Date.parse(plan.verifiedUntil);
    const entitlementExpiresAt = plan.entitlementExpiresAt === null
      ? null
      : Date.parse(plan.entitlementExpiresAt);
    const current = this.now();
    const currentVerification = Number.isFinite(verifiedUntil) && verifiedUntil > current;
    const currentEntitlement =
      plan.kind === 'pro' &&
      entitlementExpiresAt !== null &&
      Number.isFinite(entitlementExpiresAt) &&
      entitlementExpiresAt > current;
    this.allowance = Object.freeze(plan.allowance);
    this.verifiedPlan = Object.freeze({
      ...plan,
      allowance: Object.freeze({ ...plan.allowance }),
    });
    this.entitlementActive = currentVerification && currentEntitlement;
    this.planStatus = this.entitlementActive
      ? 'pro_verified'
      : currentVerification && plan.kind === 'free'
        ? 'free'
        : 'pro_verification_needed';
  }

  private requireVerification(): void {
    this.entitlementActive = false;
    this.verifiedPlan = null;
    this.planStatus = this.sdkShowsPro ? 'pro_verification_needed' : 'free';
  }

  private async refreshVerifiedPlan(): Promise<BillingSnapshot> {
    try {
      this.applyVerifiedPlan(await this.options.planApi.sync(new AbortController().signal));
      return this.snapshot('ready');
    } catch {
      this.requireVerification();
      return this.snapshot('error');
    }
  }

  private snapshot(availability: BillingAvailability): BillingSnapshot {
    return {
      availability,
      planStatus: this.planStatus,
      entitlementActive: this.entitlementActive,
      allowance: this.allowance,
      verifiedPlan: this.verifiedPlan,
      products: this.products,
    };
  }
}
