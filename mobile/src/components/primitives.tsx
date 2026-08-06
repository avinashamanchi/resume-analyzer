import React, { type ReactNode, useContext } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaInsetsContext, SafeAreaView } from 'react-native-safe-area-context';

import { tokens } from '../theme/tokens';

const ZERO_INSETS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

export function Screen({
  children,
  bottomInset = 'safe-area',
}: Readonly<{
  children: ReactNode;
  bottomInset?: 'safe-area' | 'tab-bar';
}>) {
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        testID="screen-scroll-view"
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingLeft: 20 + insets.left,
            paddingRight: 20 + insets.right,
            paddingBottom: 56 + (bottomInset === 'safe-area' ? insets.bottom : 0),
          },
        ]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Eyebrow({ children }: Readonly<{ children: ReactNode }>) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function Title({ children }: Readonly<{ children: ReactNode }>) {
  return <Text accessibilityRole="header" style={styles.title}>{children}</Text>;
}

export function Card({
  children,
  style,
}: Readonly<{ children: ReactNode; style?: ViewStyle }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function AppButton({
  label,
  onPress,
  disabled = false,
  tone = 'primary',
  accessibilityLabel,
  accessibilityHint,
}: Readonly<{
  label: string;
  onPress(): void;
  disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'danger' | 'quiet';
  accessibilityLabel?: string;
  accessibilityHint?: string;
}>) {
  const buttonStyle: ViewStyle = tone === 'primary'
    ? styles.buttonPrimary
    : tone === 'danger'
      ? styles.buttonDanger
      : tone === 'quiet'
        ? styles.buttonQuiet
        : styles.buttonSecondary;
  const textStyle: TextStyle = tone === 'primary' ? styles.buttonPrimaryText : styles.buttonText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, buttonStyle, disabled && styles.disabled, pressed && !disabled && styles.pressed]}>
      <Text style={[styles.buttonLabel, textStyle]}>{label}</Text>
    </Pressable>
  );
}

export const uiStyles = StyleSheet.create({
  sectionTitle: { color: tokens.color.text, fontSize: 20, lineHeight: 26, fontWeight: '700' },
  body: { color: tokens.color.text, fontSize: 16, lineHeight: 24 },
  muted: { color: tokens.color.muted, fontSize: 15, lineHeight: 22 },
  caption: { color: tokens.color.muted, fontSize: 13, lineHeight: 18, letterSpacing: 0.2 },
  stack: { flexDirection: 'column', rowGap: tokens.space.md },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: tokens.color.border },
  input: {
    minHeight: 120,
    borderColor: tokens.color.border,
    borderWidth: 1,
    borderRadius: tokens.radius.control,
    color: tokens.color.text,
    backgroundColor: tokens.color.background,
    fontSize: 16,
    lineHeight: 23,
    padding: 14,
    textAlignVertical: 'top',
  },
});

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: tokens.color.background },
  scrollContent: {
    flexGrow: 1,
    paddingTop: 24,
    rowGap: tokens.space.lg,
  },
  eyebrow: {
    color: tokens.color.accent,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: { color: tokens.color.text, fontSize: 36, lineHeight: 42, fontWeight: '800', letterSpacing: -1 },
  card: {
    backgroundColor: tokens.color.surface,
    borderColor: tokens.color.border,
    borderWidth: 1,
    borderRadius: tokens.radius.card,
    padding: 18,
    rowGap: tokens.space.md,
  },
  button: {
    minHeight: tokens.target.minimum,
    minWidth: tokens.target.minimum,
    borderRadius: tokens.radius.control,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  buttonPrimary: { backgroundColor: tokens.color.accent, borderColor: tokens.color.accent },
  buttonSecondary: { backgroundColor: tokens.color.surfaceRaised, borderColor: tokens.color.border },
  buttonDanger: { backgroundColor: 'transparent', borderColor: tokens.color.danger },
  buttonQuiet: { backgroundColor: 'transparent', borderColor: tokens.color.border },
  buttonLabel: { fontSize: 16, lineHeight: 21, fontWeight: '700', textAlign: 'center' },
  buttonPrimaryText: { color: tokens.color.accentInk },
  buttonText: { color: tokens.color.text },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.78 },
});
