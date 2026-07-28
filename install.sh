#!/bin/bash
rm -rf dist
npm run build
RPM=$(ls dist/*.rpm)
sudo rpm-ostree usroverlay || true
rpm2cpio $RPM | sudo cpio -fuidmv -D /

sudo update-desktop-database /usr/share/applications &>/dev/null || true
sudo gtk-update-icon-cache /usr/share/icons/hicolor &>/dev/null || true
