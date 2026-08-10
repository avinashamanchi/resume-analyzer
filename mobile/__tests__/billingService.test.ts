import {
  PurchaseCancelledError,
  RevenueCatBillingService,
  type RevenueCatModule,
} from '../src/billing/revenueCatService';

const monthly = {
  identifier: '$rc_monthly',
  packageType: 'MONTHLY',
  product: {
    identifier: 'com.avinashamanchi.resumeai.pro.monthly',
    title: 'Resume.AI Pro Monthly',
    description: 'Unlimited saved reports and PDF exports.',
    priceString: '$4.99',
    subscriptionPeriod: 'P1M',
  },
};

const annual = {
  identifier: '$rc_annual',
  packageType: 'ANNUAL',
  product: {
    identifier: 'com.avinashamanchi.resumeai.pro.annual',
    title: 'Resume.AI Pro Annual',
    description: 'Unlimited saved reports and PDF exports.',
    priceString: '$39.99',
    subscriptionPeriod: 'P1Y',
  },
};

type CustomerInfo = Awaited<ReturnType<RevenueCatModule['getCustomerInfo']>>;

const customerInfo = (active: boolean): CustomerInfo => ({
  entitlements: {
    active: active ? { resume_pro: { isActive: true } } : {},
  },
});

function fakeModule(
  overrides: Partial<Pick<RevenueCatModule, 'getCustomerInfo' | 'getOfferings'>> = {},
): RevenueCatModule & {
  configure: jest.Mock;
  purchasePackage: jest.Mock;
  restorePurchases: jest.Mock;
} {
  return {
    configure: jest.fn(),
    getOfferings: jest.fn(async () => ({
      current: { availablePackages: [monthly, annual] },
    })),
    getCustomerInfo: jest.fn(async () => customerInfo(false)),
    purchasePackage: jest.fn(async () => ({ customerInfo: customerInfo(true) })),
    restorePurchases: jest.fn(async () => customerInfo(true)),
    ...overrides,
  };
}

it('keeps Expo Go purchases unavailable without loading native billing code', async () => {
  const loader = jest.fn();
  const service = new RevenueCatBillingService({
    apiKey: 'appl_public_key',
    entitlementId: 'resume_pro',
    executionEnvironment: 'storeClient',
    moduleLoader: loader,
    productIds: [
      'com.avinashamanchi.resumeai.pro.monthly',
      'com.avinashamanchi.resumeai.pro.annual',
    ],
  });

  await expect(service.load()).resolves.toEqual({
    availability: 'preview',
    entitlementActive: false,
    products: [],
  });
  expect(loader).not.toHaveBeenCalled();
});

it('maps native StoreKit products and activates only the configured entitlement', async () => {
  const purchases = fakeModule();
  const service = new RevenueCatBillingService({
    apiKey: 'appl_public_key',
    entitlementId: 'resume_pro',
    executionEnvironment: 'standalone',
    moduleLoader: () => purchases,
    productIds: [
      'com.avinashamanchi.resumeai.pro.monthly',
      'com.avinashamanchi.resumeai.pro.annual',
    ],
  });

  await expect(service.load()).resolves.toEqual({
    availability: 'ready',
    entitlementActive: false,
    products: [
      {
        id: 'com.avinashamanchi.resumeai.pro.monthly',
        title: 'Resume.AI Pro Monthly',
        description: 'Unlimited saved reports and PDF exports.',
        price: '$4.99',
        period: 'P1M',
      },
      {
        id: 'com.avinashamanchi.resumeai.pro.annual',
        title: 'Resume.AI Pro Annual',
        description: 'Unlimited saved reports and PDF exports.',
        price: '$39.99',
        period: 'P1Y',
      },
    ],
  });
  expect(purchases.configure).toHaveBeenCalledWith({ apiKey: 'appl_public_key' });

  await expect(service.purchase('com.avinashamanchi.resumeai.pro.annual')).resolves
    .toMatchObject({ availability: 'ready', entitlementActive: true });
  expect(purchases.purchasePackage).toHaveBeenCalledWith(annual);

  await expect(service.restore()).resolves
    .toMatchObject({ availability: 'ready', entitlementActive: true });
  expect(purchases.restorePurchases).toHaveBeenCalledTimes(1);
});

it('reports a cancelled native purchase without granting access', async () => {
  const purchases = fakeModule();
  purchases.purchasePackage.mockRejectedValueOnce({ userCancelled: true });
  const service = new RevenueCatBillingService({
    apiKey: 'appl_public_key',
    entitlementId: 'resume_pro',
    executionEnvironment: 'standalone',
    moduleLoader: () => purchases,
    productIds: ['com.avinashamanchi.resumeai.pro.monthly'],
  });
  await service.load();

  await expect(service.purchase('com.avinashamanchi.resumeai.pro.monthly'))
    .rejects.toBeInstanceOf(PurchaseCancelledError);
});

it('retains verified Pro access when the offerings catalog fails transiently', async () => {
  const purchases = fakeModule({
    getCustomerInfo: jest.fn(async () => customerInfo(true)),
    getOfferings: jest.fn(async () => { throw new Error('catalog unavailable'); }),
  });
  const service = new RevenueCatBillingService({
    apiKey: 'appl_public_key',
    entitlementId: 'resume_pro',
    executionEnvironment: 'standalone',
    moduleLoader: () => purchases,
    productIds: ['com.avinashamanchi.resumeai.pro.monthly'],
  });

  await expect(service.load()).resolves.toEqual({
    availability: 'error',
    entitlementActive: true,
    products: [],
  });
});

it('can purchase a mapped product when entitlement refresh fails during catalog loading', async () => {
  const purchases = fakeModule({
    getCustomerInfo: jest.fn(async () => { throw new Error('entitlement refresh unavailable'); }),
  });
  const service = new RevenueCatBillingService({
    apiKey: 'appl_public_key',
    entitlementId: 'resume_pro',
    executionEnvironment: 'standalone',
    moduleLoader: () => purchases,
    productIds: ['com.avinashamanchi.resumeai.pro.monthly'],
  });

  await expect(service.purchase('com.avinashamanchi.resumeai.pro.monthly')).resolves
    .toMatchObject({ availability: 'ready', entitlementActive: true });
  expect(purchases.purchasePackage).toHaveBeenCalledWith(monthly);
});
