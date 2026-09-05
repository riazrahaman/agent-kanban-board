.PHONY: all test build clean sec start

all: test build

test:
	npm test

build:
	npm run build

start:
	npm start

sec:
	@echo "Running security checks..."
	@# Verify no personal absolute home directories in tracked code
	@! git grep -n -E '(/Users/[a-zA-Z0-9]+|/home/[a-zA-Z0-9]+)' -- ':!Makefile'
	@# Verify no dangerouslySetInnerHTML in client code
	@! git grep -n 'dangerouslySetInnerHTML' client/src/
	@echo "All security checks passed."
