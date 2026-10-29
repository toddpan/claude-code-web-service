<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-code.webservice</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>__NODE__</string>
    <string>__APP_DIR__/app/service.mjs</string>
    <string>--data-dir</string>
    <string>__APP_DIR__</string>
  </array>
  <key>Comment</key>
  <string>caffeinate 中转：规避 macOS TCC 对 launchd 派生树中 claude(Bun) 二进制的归因死锁（claude 在 launchd 直接子树下启动即挂起）</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>__HOME__</string>
    <key>PATH</key>
    <string>__NODE_DIR__:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>__APP_DIR__/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>__APP_DIR__/logs/launchd.err.log</string>
</dict>
</plist>
