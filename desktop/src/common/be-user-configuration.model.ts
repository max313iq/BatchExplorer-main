import { BatchFlaskUserConfiguration, EntityConfigurationView } from "@batch-flask/core";

/**
 * General configuration used both on browser and desktop
 */
export interface BEUserConfiguration extends BatchFlaskUserConfiguration {
    theme: string;

    externalBrowserAuth: boolean;

    features: {
        poolControlWorkbench: boolean,
    };

    subscriptions: {
        ignore: string[],
    };

    update: {
        channel: string | null,
        updateOnQuit: boolean,
    };

    storage: {
        defaultUploadContainer: string,
    };

    nodeConnect: {
        defaultUsername: string,
    };

    /**
     * Data from the BatchExplorer-data repository.
     * This is general configuration that can be updated for every user of Batch Explorer.
     */
    githubData: {
        repo: string,
        branch: string,
    };

    tenants: {
        [tenantId: string]: "active" | "inactive"
    };

    poolControlWorkbench: {
        discovery: {
            includeNodeCountsInMasterTable: boolean,
            maxPoolsPerAccountPerPage: number,
        },
        refresh: {
            autoRefreshEnabled: boolean,
            autoRefreshIntervalSeconds: number,
        },
        throttling: {
            concurrency: number,
            delayMsBetweenRequests: number,
            retryAttempts: number,
            retryBackoffSeconds: number[],
        },
        safety: {
            requireConfirmationsForDestructiveActions: boolean,
            maxNodeRemoveBatchSize: number,
        },
    };
}

export const DEFAULT_BE_USER_CONFIGURATION: BEUserConfiguration = {
    entityConfiguration: {
        defaultView: EntityConfigurationView.Pretty,
    },
    subscriptions: {
        ignore: [],
    },
    features: {
        poolControlWorkbench: false,
    },
    tenants: {},
    update: {
        channel: null,
        updateOnQuit: true,
    },
    storage: {
        defaultUploadContainer: "batch-explorer-input",
    },
    nodeConnect: {
        defaultUsername: "batch-explorer-user",
    },
    githubData: {
        repo: "Azure/BatchExplorer-data",
        branch: "master",
    },
    poolControlWorkbench: {
        discovery: {
            includeNodeCountsInMasterTable: true,
            maxPoolsPerAccountPerPage: 1000,
        },
        refresh: {
            autoRefreshEnabled: false,
            autoRefreshIntervalSeconds: 30,
        },
        throttling: {
            concurrency: 1,
            delayMsBetweenRequests: 250,
            retryAttempts: 5,
            retryBackoffSeconds: [2, 4, 8, 16, 32],
        },
        safety: {
            requireConfirmationsForDestructiveActions: true,
            maxNodeRemoveBatchSize: 100,
        },
    },
    theme: "classic",
    externalBrowserAuth: true
};
