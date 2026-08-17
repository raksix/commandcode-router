module.exports = {
  apps: [
    {
      name: 'commandcode-router',
      script: 'server.js',
      cwd: '/root/commandcode-router',
      env: {
        CALLBACK_URL: 'https://commandcode-router.fermag.com.tr/callback'
      }
    }
  ]
};
