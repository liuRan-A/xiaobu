import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.xiaobu.companion',
  appName: '小卜',
  webDir: 'dist',

  // 无游戏引擎：WebView 直接承载 Canvas2D，Capacitor 只提供设备能力
  android: {
    allowMixedContent: false,
    backgroundColor: '#FDF9F6', // ★ 原生窗口底色 = 暖奶油，杜绝启动瞬间白屏
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#FDF9F6',
  },

  plugins: {
    // ★ 不挂原生启动图：首帧必须就是我们自己的黄昏小屋，不要"先白后黄"的闪烁
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#FDF9F6',
      showSpinner: false,
    },
  },
}

export default config
