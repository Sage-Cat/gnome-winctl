PREFIX ?= $(HOME)/.local
EXTENSION_UUID := gnome-winctl@sagecat.local

.PHONY: install uninstall test

install:
	install -d "$(PREFIX)/bin" "$(PREFIX)/share/gnome-shell/extensions"
	ln -sfn "$(CURDIR)/bin/gnome-winctl" "$(PREFIX)/bin/gnome-winctl"
	ln -sfn "$(CURDIR)/extension/$(EXTENSION_UUID)" "$(PREFIX)/share/gnome-shell/extensions/$(EXTENSION_UUID)"
	@echo "Installed gnome-winctl. Enable $(EXTENSION_UUID), then log out and back in if GNOME has cached extension metadata."

uninstall:
	rm -f "$(PREFIX)/bin/gnome-winctl" "$(PREFIX)/share/gnome-shell/extensions/$(EXTENSION_UUID)"

test:
	PYTHONPATH=src python3 -m unittest discover -s tests -v
	node --input-type=module --check < extension/$(EXTENSION_UUID)/extension.js

