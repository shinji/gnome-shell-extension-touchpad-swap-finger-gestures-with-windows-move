all: build install

.PHONY: build install

UUID := $(shell jq -r .uuid metadata.json)

build:
	glib-compile-schemas --strict --targetdir=schemas/ schemas
	gnome-extensions pack --force

install:
	gnome-extensions install --force ${UUID}.shell-extension.zip

uninstall:
	gnome-extensions uninstall ${UUID}

lint:
	eslint ./

pretty:
	prettier --single-quote --write "**/*.js"

clean:
	rm -f *.zip
	rm -f schemas/*.compiled
