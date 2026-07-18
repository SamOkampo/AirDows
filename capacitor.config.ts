import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.airdows.app',
  appName: 'AirDows',
  webDir: 'public',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false
  },
  plugins: {
    AirDowsRuntime: {
      signalingUrl: process.env.AIRDOWS_SIGNALING_URL || ''
    }
  }
};

export default config;
