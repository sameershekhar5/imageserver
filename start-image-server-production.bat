@echo off
echo Starting Image Upload Server for Production...
echo Environment: 192.168.0.13

set SERVER_HOST=192.168.0.13
set FRONTEND_URL=http://192.168.0.13:81
set NODE_ENV=production

echo Host: %SERVER_HOST%
echo Frontend URL: %FRONTEND_URL%
echo Starting server...

node image-upload-server.js
