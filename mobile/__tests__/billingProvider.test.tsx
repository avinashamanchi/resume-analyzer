import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import {
  BillingProvider,
  type BillingService,
  useBilling,
} from '../src/billing/BillingProvider';
import type { BillingSnapshot } from '../src/billing/revenueCatService';

const freeSnapshot: BillingSnapshot = {
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

function Probe() {
  const billing = useBilling();
  return (
    <>
      <Text testID="billing-status">{`${billing.availability}:${billing.planStatus}:${billing.entitlementActive}:${billing.products.length}`}</Text>
      <Text testID="billing-message">{billing.message ?? ''}</Text>
      <Pressable accessibilityRole="button" onPress={() => void billing.purchase('com.avinashamanchi.resumeai.pro.monthly')}>
        <Text>Purchase Pro</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => void billing.restore()}>
        <Text>Restore Pro</Text>
      </Pressable>
    </>
  );
}

it('loads StoreKit products and updates the entitlement after purchase and restore', async () => {
  const service: BillingService = {
    load: jest.fn(async () => freeSnapshot),
    purchase: jest.fn(async () => ({ ...freeSnapshot, planStatus: 'pro_verified' as const, entitlementActive: true })),
    restore: jest.fn(async () => ({ ...freeSnapshot, planStatus: 'pro_verified' as const, entitlementActive: true })),
  };
  const view = render(<BillingProvider service={service}><Probe /></BillingProvider>);

  await waitFor(() => expect(view.getByTestId('billing-status').props.children).toBe('ready:free:false:1'));
  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Purchase Pro' })); });
  await waitFor(() => expect(view.getByTestId('billing-status').props.children).toBe('ready:pro_verified:true:1'));
  expect(view.getByTestId('billing-message').props.children).toBe('Resume.AI Pro is active.');

  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Restore Pro' })); });
  expect(service.restore).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('billing-message').props.children).toBe('Purchases restored. Resume.AI Pro is active.');
});
