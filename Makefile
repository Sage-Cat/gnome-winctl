PREFIX ?= $(HOME)/.local
EXTENSION_UUID := gnome-winctl-v3@sagecat.local
LEGACY_STUB_UUID := workspace-state@sagecat.local
RUNTIME_COMMANDS := python3 gdbus gnome-extensions

.PHONY: install uninstall test

install:
	@for command in $(RUNTIME_COMMANDS); do \
		command -v "$$command" >/dev/null 2>&1 || { echo "Missing runtime command: $$command" >&2; exit 1; }; \
	done
	install -d "$(PREFIX)/bin" "$(PREFIX)/share/gnome-shell/extensions/$(EXTENSION_UUID)"
	ln -sfn "$(CURDIR)/bin/gnome-winctl" "$(PREFIX)/bin/gnome-winctl"
	install -m 0644 extension/$(EXTENSION_UUID)/*.js extension/$(EXTENSION_UUID)/metadata.json "$(PREFIX)/share/gnome-shell/extensions/$(EXTENSION_UUID)/"
	python3 scripts/install_legacy_stub.py "$(CURDIR)/extension/$(LEGACY_STUB_UUID)" "$(PREFIX)/share/gnome-shell/extensions/$(LEGACY_STUB_UUID)"
	@echo "Installed gnome-winctl. Enable $(EXTENSION_UUID), then log out and back in if GNOME has cached extension metadata."

uninstall:
	rm -f "$(PREFIX)/bin/gnome-winctl" "$(PREFIX)/share/gnome-shell/extensions/$(LEGACY_STUB_UUID)"
	rm -rf "$(PREFIX)/share/gnome-shell/extensions/$(EXTENSION_UUID)"

test:
	PYTHONPATH=src python3 -m unittest discover -s tests -v
	node --test tests/*.mjs
	node --input-type=module --check < extension/$(EXTENSION_UUID)/extension.js
	node --input-type=module --check < extension/$(EXTENSION_UUID)/monitorPolicy.js
	node --input-type=module --check < extension/$(EXTENSION_UUID)/windowPlacement.js
	node --input-type=module --check < extension/$(EXTENSION_UUID)/placementRequests.js
	node --input-type=module --check < extension/$(EXTENSION_UUID)/buildInfo.js
	node --input-type=module --check < extension/$(LEGACY_STUB_UUID)/extension.js
