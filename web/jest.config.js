/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * Jest config for `@batch/explorer-web`.
 *
 * The base config from `@batch/common-config/jest-common` provides the
 * monorepo-wide TypeScript transform, module resolution, and reporters.
 * This file overrides:
 *   - test environment (jsdom for component tests)
 *   - coverage scope (broadened from the migration default to cover the
 *     state, services, agents, hooks, and scheduling layers — see
 *     Design Contract §9 for targets)
 *   - coverage thresholds (≥60% line on the targeted layers)
 *   - setup files (jest-dom matchers + project-specific test setup)
 */
module.exports = require("@batch/common-config/jest-common").createConfig(
    "explorer-web",
    {
        testEnvironment: "jsdom",
        setupFilesAfterEnv: [
            "<rootDir>/src/__tests__/setup-tests.ts",
            "<rootDir>/src/__tests__/setup-jest-dom.ts",
        ],
        moduleNameMapper: {
            "^@/(.*)$": "<rootDir>/src/$1",
        },
        // Coverage: broadened from migration's narrow default. Layers under
        // multi-region/{services,store,agents,hooks,scheduling} are the
        // primary coverage target. UI components beyond smoke tests are
        // nice-to-have.
        collectCoverageFrom: [
            "src/multi-region/services/**/*.{ts,tsx}",
            "src/multi-region/store/**/*.{ts,tsx}",
            "src/multi-region/agents/**/*.{ts,tsx}",
            "src/multi-region/hooks/**/*.{ts,tsx}",
            "src/multi-region/scheduling/**/*.{ts,tsx}",
            "src/multi-region/auth/**/*.{ts,tsx}",
            "src/multi-region/components/shared/**/*.{ts,tsx}",
            "src/components/application.tsx",
            "!**/__tests__/**",
            "!**/__mocks__/**",
            "!**/*.d.ts",
            "!**/index.ts",
        ],
        coverageThreshold: {
            "src/multi-region/services/": {
                lines: 60,
                statements: 60,
                branches: 50,
                functions: 60,
            },
            "src/multi-region/store/": {
                lines: 60,
                statements: 60,
                branches: 50,
                functions: 60,
            },
            "src/multi-region/agents/": {
                lines: 60,
                statements: 60,
                branches: 50,
                functions: 60,
            },
            "src/multi-region/hooks/": {
                lines: 60,
                statements: 60,
                branches: 50,
                functions: 60,
            },
            "src/multi-region/scheduling/": {
                lines: 70,
                statements: 70,
                branches: 60,
                functions: 70,
            },
        },
        coverageReporters: ["text-summary", "html", "lcov"],
        // Cleared between tests for hermetic isolation.
        clearMocks: true,
        restoreMocks: true,
    }
);
