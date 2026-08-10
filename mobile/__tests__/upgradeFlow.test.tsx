import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Linking from 'expo-linking';

import UpgradeScreen from '../app/upgrade';
import { BillingProvider, type BillingService } from '../src/billing/BillingProvider';
import type { BillingSnapshot } from '../src/billing/revenueCatService';
import { MANAGE_SUBSCRIPTIONS_URL, PRIVACY_URL, TERMS_URL } from '../src/legal/links';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('expo-linking', () => ({ openURL: jest.fn(async () => undefined) }));

const ready: BillingSnapshot = {
  availability: 'ready',
  planStatus: 'free',
  entitlementActive: false,
  allowance: { used: 1, limit: 3, resetsAt: '2099-09-01T00:00:00Z' },
  products: [{
    id: 'com.avinashamanchi.resumeai.pro.monthly',
    title: 'Resume.AI Pro Monthly',
    description: 'Unlimited saved reports and PDF exports.',
    price: '$4.99',
    period: 'P1M',
  }],
};

function service(snapshot: BillingSnapshot = ready): BillingService {
  return {
    load: jest.fn(async () => snapshot),
    purchase: jest.fn(async () => ({ ...snapshot, planStatus: 'pro_verified' as const, entitlementActive: true })),
    restore: jest.fn(async () => snapshot),
    linkApple: jest.fn(async () => snapshot),
  };
}

it('shows a clear free escape, StoreKit price, restore, and legal links', async () => {
  const billing = service();
  const view = render(<BillingProvider service={billing}><UpgradeScreen /></BillingProvider>);

  await waitFor(() => expect(view.getByRole('button', { name: 'Choose Resume.AI Pro Monthly for $4.99 per month' })).toBeTruthy());
  expect(view.getByText('Free')).toBeTruthy();
  expect(view.getByText('Resume.AI Pro')).toBeTruthy();
  expect(view.getByText(/Save up to 3 reports locally/i)).toBeTruthy();
  expect(view.getByText(/Up to 10,000 local reports/i)).toBeTruthy();
  expect(view.getByText(/1 of 3 AI feedback requests used this month/i)).toBeTruthy();
  expect(view.getByText(/reports, resume versions, and jobs stay on this device and do not sync/i)).toBeTruthy();
  expect(view.queryByText(/Unlimited local report history/i)).toBeNull();
  expect(view.queryByText(/ongoing AI analysis service/i)).toBeNull();
  expect(view.queryByText(/free trial/i)).toBeNull();

  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Continue with Free' })); });
  expect(mockBack).toHaveBeenCalledTimes(1);

  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Restore Purchases' })); });
  expect(billing.restore).toHaveBeenCalledTimes(1);

  expect(view.queryByRole('button', { name: 'Use Pro on my other devices' })).toBeNull();

  await act(async () => { fireEvent.press(view.getByRole('link', { name: 'Privacy Policy' })); });
  expect(Linking.openURL).toHaveBeenCalledWith(PRIVACY_URL);
  await act(async () => { fireEvent.press(view.getByRole('link', { name: 'Terms of Use' })); });
  expect(Linking.openURL).toHaveBeenCalledWith(TERMS_URL);
  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Manage Apple subscription' })); });
  expect(Linking.openURL).toHaveBeenCalledWith(MANAGE_SUBSCRIPTIONS_URL);
});

it('does not create an Apple-linked Resume.AI account even after Pro is verified', async () => {
  const active: BillingSnapshot = {
    ...ready,
    planStatus: 'pro_verified',
    entitlementActive: true,
    allowance: { used: 4, limit: 100, resetsAt: '2099-09-01T00:00:00Z' },
  };
  const billing = service(active);
  const view = render(<BillingProvider service={billing}><UpgradeScreen /></BillingProvider>);

  await waitFor(() => expect(view.getByText(/Resume\.AI Pro is server verified/i)).toBeTruthy());
  expect(view.getByText(/4 of 100 AI feedback requests used this month/i)).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Use Pro on my other devices' })).toBeNull();
  expect(billing.linkApple).not.toHaveBeenCalled();
});

it('keeps restore available when offerings fail to load', async () => {
  const failed: BillingSnapshot = {
    availability: 'error',
    planStatus: 'free',
    entitlementActive: false,
    allowance: null,
    products: [],
  };
  const billing = service(failed);
  const view = render(<BillingProvider service={billing}><UpgradeScreen /></BillingProvider>);

  await waitFor(() => expect(view.getByText(/could not load purchase options/i)).toBeTruthy());
  expect(view.getByRole('button', { name: 'Restore Purchases' }).props.accessibilityState.disabled).toBe(false);
  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Restore Purchases' })); });
  expect(billing.restore).toHaveBeenCalledTimes(1);
});

it('labels Expo Go as a preview and never exposes a fake purchase action', async () => {
  const preview: BillingSnapshot = {
    availability: 'preview',
    planStatus: 'free',
    entitlementActive: false,
    allowance: null,
    products: [],
  };
  const view = render(<BillingProvider service={service(preview)}><UpgradeScreen /></BillingProvider>);

  await waitFor(() => expect(view.getByText(/Expo Go can preview this screen/i)).toBeTruthy());
  expect(view.queryByText(/\$4\.99/)).toBeNull();
  expect(view.queryByRole('button', { name: /Choose Resume\.AI Pro/i })).toBeNull();
  expect(view.getByRole('button', { name: 'Continue with Free' })).toBeTruthy();
});
