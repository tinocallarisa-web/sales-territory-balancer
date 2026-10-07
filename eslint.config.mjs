import powerbiVisualsConfigs from "eslint-plugin-powerbi-visuals";

export default [
    powerbiVisualsConfigs.configs.recommended,
    {
        // build-test.js es un script local de Node, no codigo del visual: nunca viaja dentro
        // del .pbiviz, asi que las reglas de seguridad del visual no le aplican.
        ignores: [
            "node_modules/**",
            "dist/**",
            ".vscode/**",
            ".tmp/**",
            "build-test.js",
            "webpack.statistics*.html"
        ],
    },
];
