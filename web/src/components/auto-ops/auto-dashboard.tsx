import * as React from "react";
import { Stack, IStackTokens, IStackStyles } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Pivot, PivotItem } from "@fluentui/react/lib/Pivot";
import { useAppTheme } from "@azure/bonito-ui/lib/theme";
import { BulkPoolCreator } from "./bulk-pool-creator";
import { PoolListView } from "./pool-list-view";

const stackTokens: IStackTokens = { childrenGap: 16 };

export const AutoDashboard: React.FC = () => {
    const theme = useAppTheme();
    const [refreshKey, setRefreshKey] = React.useState(0);

    const triggerRefresh = React.useCallback(() => {
        setRefreshKey((k) => k + 1);
    }, []);

    const containerStyles: IStackStyles = {
        root: {
            padding: "24px",
            maxWidth: "1400px",
            margin: "0 auto",
            width: "100%",
        },
    };

    const headerStyles: React.CSSProperties = {
        background: `linear-gradient(135deg, ${theme.palette.themePrimary}, ${theme.palette.themeDarker})`,
        color: "#fff",
        padding: "32px",
        borderRadius: "8px",
        marginBottom: "8px",
    };

    return (
        <Stack styles={containerStyles} tokens={stackTokens}>
            <div style={headerStyles}>
                <Text
                    variant="xxLarge"
                    style={{ color: "#fff", fontWeight: 700 }}
                    block
                >
                    Batch Explorer Full Auto
                </Text>
                <Text
                    variant="medium"
                    style={{ color: "rgba(255,255,255,0.85)", marginTop: 4 }}
                    block
                >
                    Bulk-create up to 5,000 pools and nodes in a single
                    operation. Configure templates, launch everything with one
                    press, and monitor progress in real time.
                </Text>
            </div>

            <Pivot
                aria-label="Auto operations"
                styles={{
                    root: { marginBottom: 8 },
                }}
            >
                <PivotItem headerText="Bulk Create Pools" itemIcon="Add">
                    <BulkPoolCreator onCreated={triggerRefresh} />
                </PivotItem>
                <PivotItem headerText="Pool Overview" itemIcon="ViewList">
                    <PoolListView refreshKey={refreshKey} />
                </PivotItem>
            </Pivot>
        </Stack>
    );
};
