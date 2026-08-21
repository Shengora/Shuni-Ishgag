module.exports = {
  apps: [
    {
      name: "api-server",
      script: "artifacts/api-server/start-prod.sh",
      // Execute the bash script directly
      interpreter: "bash",
      // Set the working directory to the workspace root
      cwd: ".",
      // Auto-restart if it crashes
      autorestart: true,
      // Restart if memory usage exceeds this limit
      max_memory_restart: "1G",
      // Prepend timestamp to logs
      log_date_format: "YYYY-MM-DD HH:mm Z",
      // Output log file
      out_file: "./logs/api-server-out.log",
      // Error log file
      error_file: "./logs/api-server-error.log",
      // Merge logs if multiple instances (not applicable here, but good practice)
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
