'use strict';

function stripDevelopmentNetworkKeys(infoPlist) {
  const next = { ...infoPlist };
  delete next.NSBonjourServices;
  delete next.NSLocalNetworkUsageDescription;

  const currentTransport = next.NSAppTransportSecurity;
  if (currentTransport && typeof currentTransport === 'object' && !Array.isArray(currentTransport)) {
    const transport = { ...currentTransport };
    transport.NSAllowsArbitraryLoads = false;
    delete transport.NSAllowsArbitraryLoadsForMedia;
    delete transport.NSAllowsArbitraryLoadsInWebContent;
    delete transport.NSAllowsLocalNetworking;
    delete transport.NSExceptionDomains;
    next.NSAppTransportSecurity = transport;
  } else next.NSAppTransportSecurity = { NSAllowsArbitraryLoads: false };
  return next;
}

function withReleaseNetworkPolicy(config) {
  if (process.env.EAS_BUILD_PROFILE !== 'production') return config;
  const { withInfoPlist } = require('expo/config-plugins');
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults = stripDevelopmentNetworkKeys(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withReleaseNetworkPolicy;
module.exports.stripDevelopmentNetworkKeys = stripDevelopmentNetworkKeys;
