import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { Screen } from '../src/components/primitives';

const mockInsets = { top: 47, right: 13, bottom: 34, left: 11 };

function withMockInsets(children: React.ReactNode) {
  return (
    <SafeAreaInsetsContext.Provider value={mockInsets}>
      {children}
    </SafeAreaInsetsContext.Provider>
  );
}

describe('Screen safe-area structure', () => {
  it('adds lateral and bottom device insets to a stack screen', async () => {
    const view = await render(withMockInsets(
      <Screen><Text>Stack content</Text></Screen>,
    ));
    const contentStyle = StyleSheet.flatten(
      view.getByTestId('screen-scroll-view').props.contentContainerStyle,
    );

    expect(contentStyle).toEqual(expect.objectContaining({
      paddingLeft: 31,
      paddingRight: 33,
      paddingBottom: 90,
    }));
  });

  it('leaves bottom ownership to the tab bar while retaining lateral insets', async () => {
    const view = await render(withMockInsets(
      <Screen bottomInset="tab-bar"><Text>Tab content</Text></Screen>,
    ));
    const contentStyle = StyleSheet.flatten(
      view.getByTestId('screen-scroll-view').props.contentContainerStyle,
    );

    expect(contentStyle).toEqual(expect.objectContaining({
      paddingLeft: 31,
      paddingRight: 33,
      paddingBottom: 56,
    }));
  });
});
