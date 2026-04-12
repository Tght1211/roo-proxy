module.exports = {
  apps: [
    {
      name: 'roo',
      script: './server/index.js',
      cwd: __dirname + '/..',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
