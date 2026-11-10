// electron-builder 配置：NSIS 一键、按用户装到 %LOCALAPPDATA%\Programs\sidemate、不签名、x64。
// payload 不进 files：installer-assets.mjs 把它备成 .installer-cache/payload.7z 随包带上，
// installer.nsh 装时用随包 7za 直解到 resources/app/payload，不走默认的临时目录逐个复制。
const max = process.env.SIDEMATE_MAX === '1'

module.exports = {
  appId: 'cn.deskware.sidemate',
  productName: '桌伴',
  asar: false,
  compression: max ? 'maximum' : 'normal',
  artifactName: `sidemate-setup-\${version}${max ? '-max' : ''}.\${ext}`,
  directories: { output: 'dist' },
  files: ['app/**/*', 'package.json'],
  extraResources: [{ from: '.installer-cache', to: '.' }],
  extraFiles: [{ from: 'THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' }],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], executableName: 'sidemate', icon: 'build/icon.ico' },
  nsis: {
    oneClick: true,
    perMachine: false,
    shortcutName: '桌伴',
    uninstallDisplayName: '桌伴',
    include: 'build/installer.nsh',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },
}
