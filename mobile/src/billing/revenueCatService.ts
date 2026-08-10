export type BillingAvailability = 'ready' | 'preview' | 'configuration' | 'error';

export type BillingProduct = Readonly<{
  id: string;
  title: string;
  description: string;
  price: string;
  period: string | null;
}>;

export type BillingSnapshot = Readonly<{
  availability: BillingAvailability;
  entitlementActive: boolean;
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
  configure(options: Readonly<{ apiKey: string }>): void;
  getOfferings(): Promise<Readonly<{
    current: Readonly<{ availablePackages: readonly RevenueCatPackage[] }> | null;
  }>>;
  getCustomerInfo(): Promise<RevenueCatCustomerInfo>;
  purchasePackage(item: RevenueCatPackage): Promise<Readonly<{
    customerInfo: RevenueCatCustomerInfo;
  }>>;
  restorePurchases(): Promise<RevenueCatCustomerInfo>;
}>;

type RevenueCatBillingOptions = Readonly<{
  apiKey: string | undefined;
  entitlementId: string;
  executionEnvironment: string;
  moduleLoader?: () => RevenueCatModule | Promise<RevenueCatModule>;
  productIds: readonly string[];
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

export class RevenueCatBillingService {
  private module: RevenueCatModule | null = null;
  private configured = false;
  private readonly packageByProductId = new Map<string, RevenueCatPackage>();
  private products: readonly BillingProduct[] = EMPTY_PRODUCTS;

  constructor(private readonly options: RevenueCatBillingOptions) {}

  async load(): Promise<BillingSnapshot> {
    const unavailable = this.unavailableSnapshot();
    if (unavailable !== null) return unavailable;

    try {
      const purchases = await this.getConfiguredModule();
      const [offerings, customerInfo] = await Promise.all([
        purchases.getOfferings(),
        purchases.getCustomerInfo(),
      ]);
      this.packageByProductId.clear();
      const allowed = new Set(this.options.productIds);
      const packages = offerings.current?.availablePackages ?? [];
      for (const item of packages) {
        if (allowed.has(item.product.identifier)) {
          this.packageByProductId.set(item.product.identifier, item);
        }
      }
      this.products = this.options.productIds.flatMap((productId) => {
        const item = this.packageByProductId.get(productId);
        return item ? [this.mapProduct(item)] : [];
      });
      return this.readySnapshot(customerInfo);
    } catch {
      return {
        availability: 'error',
        entitlementActive: false,
        products: EMPTY_PRODUCTS,
      };
    }
  }

  async purchase(productId: string): Promise<BillingSnapshot> {
    const unavailable = this.unavailableSnapshot();
    if (unavailable !== null) throw new BillingUnavailableError();
    const purchases = await this.getConfiguredModule();
    if (this.packageByProductId.size === 0) {
      const loaded = await this.load();
      if (loaded.availability !== 'ready') throw new BillingUnavailableError();
    }
    const item = this.packageByProductId.get(productId);
    if (!item) throw new BillingUnavailableError();
    try {
      const result = await purchases.purchasePackage(item);
      return this.readySnapshot(result.customerInfo);
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
  }

  async restore(): Promise<BillingSnapshot> {
    const unavailable = this.unavailableSnapshot();
    if (unavailable !== null) throw new BillingUnavailableError();
    try {
      const purchases = await this.getConfiguredModule();
      const customerInfo = await purchases.restorePurchases();
      return this.readySnapshot(customerInfo);
    } catch {
      throw new BillingUnavailableError();
    }
  }

  private unavailableSnapshot(): BillingSnapshot | null {
    if (this.options.executionEnvironment === 'storeClient') {
      return {
        availability: 'preview',
        entitlementActive: false,
        products: EMPTY_PRODUCTS,
      };
    }
    if (!this.options.apiKey?.trim()) {
      return {
        availability: 'configuration',
        entitlementActive: false,
        products: EMPTY_PRODUCTS,
      };
    }
    return null;
  }

  private async getConfiguredModule(): Promise<RevenueCatModule> {
    this.module ??= await (this.options.moduleLoader ?? defaultModuleLoader)();
    if (!this.configured) {
      this.module.configure({ apiKey: this.options.apiKey as string });
      this.configured = true;
    }
    return this.module;
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

  private readySnapshot(customerInfo: RevenueCatCustomerInfo): BillingSnapshot {
    return {
      availability: 'ready',
      entitlementActive:
        customerInfo.entitlements.active[this.options.entitlementId]?.isActive === true,
      products: this.products,
    };
  }
}
