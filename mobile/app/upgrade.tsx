import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useBilling } from '../src/billing/BillingProvider';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../src/components/primitives';
import { APPLE_PURCHASE_SUPPORT_URL, MANAGE_SUBSCRIPTIONS_URL, PRIVACY_URL, TERMS_URL } from '../src/legal/links';
import { tokens } from '../src/theme/tokens';

const periodLabel = (period: string | null): string => {
  if (period === 'P1M') return 'per month';
  if (period === 'P1Y') return 'per year';
  return '';
};

export default function UpgradeScreen() {
  const router = useRouter();
  const billing = useBilling();

  return (
    <Screen>
      <View>
        <Eyebrow>Resume.AI plans</Eyebrow>
        <Title>Keep the analysis free. Upgrade the workflow.</Title>
        <Text style={uiStyles.muted}>Choose Pro for deeper local organization and polished exports. You can continue with Free at any time.</Text>
        <Text style={uiStyles.muted}>Your reports, resume versions, and jobs stay on this device and do not sync.</Text>
      </View>

      <View style={styles.tiers}>
        <Card style={styles.tier}>
          <Text style={uiStyles.sectionTitle}>Free</Text>
          <Text style={uiStyles.body}>Full resume analysis and text sharing</Text>
          <Text style={uiStyles.body}>Save up to 3 reports locally</Text>
          <Text style={uiStyles.body}>Save 1 resume version and track up to 3 jobs</Text>
          <Text style={uiStyles.body}>Up to 3 AI feedback requests each month</Text>
          <Text style={uiStyles.body}>No payment required</Text>
        </Card>
        <Card style={styles.proTier}>
          <Text style={styles.proLabel}>Resume.AI Pro</Text>
          <Text style={uiStyles.body}>Up to 10,000 local reports</Text>
          <Text style={uiStyles.body}>Up to 200 resume versions and 500 tracked jobs</Text>
          <Text style={uiStyles.body}>Up to 100 AI feedback requests each month</Text>
          <Text style={uiStyles.body}>Polished PDF report exports</Text>
        </Card>
      </View>

      {billing.entitlementActive ? (
        <Card><Text accessibilityRole="alert" style={uiStyles.sectionTitle}>Resume.AI Pro is server verified for this installation.</Text></Card>
      ) : null}

      {billing.allowance !== null ? (
        <Card>
          <Text style={uiStyles.sectionTitle}>Monthly AI feedback</Text>
          <Text style={uiStyles.body}>{billing.allowance.used} of {billing.allowance.limit} AI feedback requests used this month.</Text>
          <Text style={uiStyles.muted}>Resets on {billing.allowance.resetsAt.slice(0, 10)}.</Text>
        </Card>
      ) : null}

      {billing.availability === 'preview' ? (
        <Card>
          <Text style={uiStyles.sectionTitle}>Expo Go preview</Text>
          <Text style={uiStyles.muted}>Expo Go can preview this screen, but Apple purchases require the signed App Store development build. No payment can be made here.</Text>
        </Card>
      ) : null}
      {billing.availability === 'configuration' ? (
        <Card><Text accessibilityRole="alert" style={uiStyles.muted}>App Store purchases are not configured in this build. Free remains available.</Text></Card>
      ) : null}
      {billing.availability === 'error' ? (
        <Card>
          <Text accessibilityRole="alert" style={uiStyles.muted}>The App Store could not load purchase options. Check your connection or try again later.</Text>
          <AppButton label="Reload purchase options" onPress={() => { void billing.reload(); }} disabled={billing.busy} tone="secondary" />
        </Card>
      ) : null}

      {billing.availability === 'ready' && !billing.entitlementActive ? billing.products.map((product) => {
        const period = periodLabel(product.period);
        const label = `Choose ${product.title} for ${product.price}${period ? ` ${period}` : ''}`;
        return (
          <Card key={product.id}>
            <Text style={uiStyles.sectionTitle}>{product.title}</Text>
            <Text style={styles.price}>{product.price}{period ? ` ${period}` : ''}</Text>
            <Text style={uiStyles.muted}>Includes the bounded Pro features listed above.</Text>
            <AppButton
              accessibilityLabel={label}
              label={`Choose ${product.price}${period ? ` ${period}` : ''}`}
              onPress={() => { void billing.purchase(product.id); }}
              disabled={billing.busy}
            />
          </Card>
        );
      }) : null}

      {billing.message ? <Text accessibilityRole="alert" style={styles.message}>{billing.message}</Text> : null}

      <AppButton label="Continue with Free" onPress={() => router.back()} disabled={billing.busy} tone="quiet" />
      <AppButton
        label="Restore Purchases"
        onPress={() => { void billing.restore(); }}
        disabled={billing.busy || billing.availability === 'loading' || billing.availability === 'preview' || billing.availability === 'configuration'}
        tone="secondary"
      />
      <AppButton label="Manage Apple subscription" onPress={() => { void Linking.openURL(MANAGE_SUBSCRIPTIONS_URL); }} disabled={billing.busy} tone="quiet" />

      <Text style={uiStyles.caption}>Payment is charged to your Apple Account at confirmation. Subscriptions renew automatically unless canceled at least 24 hours before the current period ends. You can manage or cancel in App Store account settings.</Text>
      <View style={styles.legalRow}>
        <Pressable accessibilityLabel="Privacy Policy" accessibilityRole="link" onPress={() => { void Linking.openURL(PRIVACY_URL); }} style={styles.legalLink}>
          <Text style={styles.legalText}>Privacy Policy</Text>
        </Pressable>
        <Pressable accessibilityLabel="Terms of Use" accessibilityRole="link" onPress={() => { void Linking.openURL(TERMS_URL); }} style={styles.legalLink}>
          <Text style={styles.legalText}>Terms of Use</Text>
        </Pressable>
        <Pressable accessibilityLabel="Apple purchase and refund help" accessibilityRole="link" onPress={() => { void Linking.openURL(APPLE_PURCHASE_SUPPORT_URL); }} style={styles.legalLink}>
          <Text style={styles.legalText}>Apple purchase and refund help</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  legalLink: { justifyContent: 'center', minHeight: tokens.target.minimum, paddingHorizontal: tokens.space.sm },
  legalRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  legalText: { color: tokens.color.accent, fontSize: 15, fontWeight: '700' },
  message: { color: tokens.color.accent, fontSize: 15, lineHeight: 22 },
  price: { color: tokens.color.text, fontSize: 24, fontWeight: '800' },
  proLabel: { color: tokens.color.accent, fontSize: 20, fontWeight: '800' },
  proTier: { borderColor: tokens.color.accent },
  tier: { flex: 1 },
  tiers: { gap: tokens.space.md },
});
