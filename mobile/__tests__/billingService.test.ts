import {
  PurchaseCancelledError,
  RevenueCatBillingService,
  type RevenueCatBillingOptions,
  type RevenueCatModule,
} from '../src/billing/revenueCatService';

const INSTALLATION_APP_USER_ID = `rai_installation_${'i'.repeat(43)}`;

const freePlan = {
  schemaVersion: 2 as const,
  kind: 'free' as const,
  verifiedUntil: '2099-08-11T00:00:00Z',
  entitlementExpiresAt: null,
  allowance: { used: 1, limit: 3 as const, resetsAt: '2099-09-01T00:00:00Z' },
};

const proPlan = {
  schemaVersion: 2 as const,
  kind: 'pro' as const,
  verifiedUntil: '2099-08-11T00:00:00Z',
  entitlementExpiresAt: '2099-09-10T00:00:00Z',
  allowance: { used: 4, limit: 100 as const, resetsAt: '2099-09-01T00:00:00Z' },
};

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
  let appUserId = INSTALLATION_APP_USER_ID;
  return {
    configure: jest.fn((options: { appUserID: string }) => { appUserId = options.appUserID; }),
    getAppUserID: jest.fn(async () => appUserId),
    getOfferings: jest.fn(async () => ({
      current: { availablePackages: [monthly, annual] },
    })),
    getCustomerInfo: jest.fn(async () => customerInfo(false)),
    purchasePackage: jest.fn(async () => ({ customerInfo: customerInfo(true) })),
    restorePurchases: jest.fn(async () => customerInfo(true)),
    logIn: jest.fn(async (nextAppUserId: string) => {
      appUserId = nextAppUserId;
      return { customerInfo: customerInfo(true), created: false };
    }),
    logOut: jest.fn(async () => {
      appUserId = INSTALLATION_APP_USER_ID;
      return customerInfo(false);
    }),
    ...overrides,
  };
}

function serviceOptions(
  purchases: RevenueCatModule,
  plans: readonly (typeof freePlan | typeof proPlan)[] = [freePlan],
  overrides: Partial<RevenueCatBillingOptions> = {},
): RevenueCatBillingOptions {
  const sync = jest.fn();
  for (const plan of plans) sync.mockResolvedValueOnce(plan);
  sync.mockResolvedValue(plans.at(-1) ?? freePlan);
  return {
    apiKey: 'appl_public_key',
    entitlementId: 'resume_pro',
    executionEnvironment: 'standalone',
    moduleLoader: () => purchases,
    productIds: [
      'com.avinashamanchi.resumeai.pro.monthly',
      'com.avinashamanchi.resumeai.pro.annual',
    ],
    planApi: { sync },
    installationTokens: {
      getOrIssueIdentity: jest.fn(async () => ({
        installationToken: 'signed-installation-token',
        revenueCatAppUserId: INSTALLATION_APP_USER_ID,
      })),
    },
    ...overrides,
  };
}

it('keeps Expo Go purchases unavailable without loading native billing code', async () => {
  const loader = jest.fn();
  const service = new RevenueCatBillingService(serviceOptions(fakeModule(), [freePlan], {
    executionEnvironment: 'storeClient',
    moduleLoader: loader,
  }));

  await expect(service.load()).resolves.toEqual({
    availability: 'preview',
    planStatus: 'free',
    entitlementActive: false,
    allowance: null,
    products: [],
  });
  expect(loader).not.toHaveBeenCalled();
});

it('maps native StoreKit products and activates only the configured entitlement', async () => {
  const purchases = fakeModule();
  const service = new RevenueCatBillingService(serviceOptions(purchases, [freePlan, proPlan, proPlan]));

  await expect(service.load()).resolves.toEqual({
    availability: 'ready',
    planStatus: 'free',
    entitlementActive: false,
    allowance: freePlan.allowance,
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
  expect(purchases.configure).toHaveBeenCalledWith({
    apiKey: 'appl_public_key',
    appUserID: INSTALLATION_APP_USER_ID,
  });

  await expect(service.purchase('com.avinashamanchi.resumeai.pro.annual')).resolves
    .toMatchObject({ availability: 'ready', planStatus: 'pro_verified', entitlementActive: true });
  expect(purchases.purchasePackage).toHaveBeenCalledWith(annual);

  await expect(service.restore()).resolves
    .toMatchObject({ availability: 'ready', planStatus: 'pro_verified', entitlementActive: true });
  expect(purchases.restorePurchases).toHaveBeenCalledTimes(1);
});

it('reports a cancelled native purchase without granting access', async () => {
  const purchases = fakeModule();
  purchases.purchasePackage.mockRejectedValueOnce({ userCancelled: true });
  const service = new RevenueCatBillingService(serviceOptions(purchases, [freePlan], {
    productIds: ['com.avinashamanchi.resumeai.pro.monthly'],
  }));
  await service.load();

  await expect(service.purchase('com.avinashamanchi.resumeai.pro.monthly'))
    .rejects.toBeInstanceOf(PurchaseCancelledError);
});

it('retains verified Pro access when the offerings catalog fails transiently', async () => {
  const purchases = fakeModule({
    getCustomerInfo: jest.fn(async () => customerInfo(true)),
    getOfferings: jest.fn(async () => { throw new Error('catalog unavailable'); }),
  });
  const service = new RevenueCatBillingService(serviceOptions(purchases, [proPlan], {
    productIds: ['com.avinashamanchi.resumeai.pro.monthly'],
  }));

  await expect(service.load()).resolves.toEqual({
    availability: 'error',
    planStatus: 'pro_verified',
    entitlementActive: true,
    allowance: proPlan.allowance,
    products: [],
  });
});

it('can purchase a mapped product when entitlement refresh fails during catalog loading', async () => {
  const purchases = fakeModule({
    getCustomerInfo: jest.fn(async () => { throw new Error('entitlement refresh unavailable'); }),
  });
  const service = new RevenueCatBillingService(serviceOptions(purchases, [freePlan, proPlan], {
    productIds: ['com.avinashamanchi.resumeai.pro.monthly'],
  }));

  await expect(service.purchase('com.avinashamanchi.resumeai.pro.monthly')).resolves
    .toMatchObject({ availability: 'ready', planStatus: 'pro_verified', entitlementActive: true });
  expect(purchases.purchasePackage).toHaveBeenCalledWith(monthly);
});

it('never accepts the RevenueCat SDK entitlement as server-verified Pro access', async () => {
  const purchases = fakeModule({
    getCustomerInfo: jest.fn(async () => customerInfo(true)),
  });
  const service = new RevenueCatBillingService(serviceOptions(purchases, [freePlan], {
    productIds: ['com.avinashamanchi.resumeai.pro.monthly'],
  }));

  await expect(service.load()).resolves.toMatchObject({
    entitlementActive: false,
    planStatus: 'free',
    allowance: { used: 1, limit: 3 },
  });
  expect(purchases.configure).toHaveBeenCalledWith({
    apiKey: 'appl_public_key',
    appUserID: INSTALLATION_APP_USER_ID,
  });
});

it('restores under the server-issued account ID before accepting linked Pro', async () => {
  const purchases = fakeModule();
  const service = new RevenueCatBillingService(serviceOptions(purchases, [freePlan]));
  await service.load();
  const verify = jest.fn(async () => proPlan);
  const accountAppUserId = `rai_account_${'a'.repeat(43)}`;

  await expect(service.linkAccount(accountAppUserId, verify)).resolves.toMatchObject({
    planStatus: 'pro_verified',
    entitlementActive: true,
  });
  expect(purchases.logIn).toHaveBeenCalledWith(accountAppUserId);
  expect(purchases.restorePurchases).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledTimes(1);
});
