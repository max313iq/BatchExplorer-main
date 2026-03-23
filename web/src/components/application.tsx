import { defaultTheme, listThemes } from "@azure/bonito-ui";
import {
    Dropdown,
    IDropdownOption,
    IDropdownStyles,
} from "@fluentui/react/lib/Dropdown";
import * as React from "react";
import { HashRouter, Route, Routes, Navigate } from "react-router-dom";
import { AppRoot } from "./layout/app-root";
import { Footer } from "./layout/footer";
import { Header } from "./layout/header";
import { Main } from "./layout/main";
import { ThemeName } from "@azure/bonito-ui/lib/theme";
import { MultiRegionDashboard } from "../multi-region";

const dropdownStyles: Partial<IDropdownStyles> = {
    dropdown: { width: 300 },
};

/**
 * Represents the entire application
 */
export const Application: React.FC = () => {
    const [theme, setTheme] = React.useState<ThemeName>(defaultTheme);

    const themeOptions = React.useMemo(() => {
        const options: IDropdownOption[] = [];
        for (const t of listThemes()) {
            options.push({ key: t.name, text: t.label });
        }
        return options;
    }, []);

    return (
        <AppRoot theme={theme}>
            <HashRouter>
                <Header>
                    <Dropdown
                        styles={dropdownStyles}
                        defaultSelectedKey={defaultTheme}
                        placeholder="Select a theme"
                        label="Theme"
                        options={themeOptions}
                        onRenderLabel={() => <></>}
                        onChange={(_, option) => {
                            if (option) {
                                setTheme(option.key as ThemeName);
                            }
                        }}
                    />
                </Header>
                <Main>
                    <Routes>
                        <Route path="/" element={<MultiRegionDashboard />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </Main>
                <Footer />
            </HashRouter>
        </AppRoot>
    );
};
