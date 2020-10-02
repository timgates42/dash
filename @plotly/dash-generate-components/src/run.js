const commander = require('commander');
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const R = require('ramda');
const yaml = require('yamljs');

const meta = require('./utils/metadata.js');

/* Utils */
function ensureDirectoryExistence(filePath) {
    var dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

/* CLI */
const __workdir = process.cwd();

commander
    .option('-c, --config <file>', 'Project config file')
    .parse(process.argv);

const { config: __config } = commander;

/* Load Configuration Files */
const configPath = path.join(__workdir, __config);
const rawConfig = fs.readFileSync(configPath, 'utf8');
const config = yaml.parse(rawConfig);

config.recipes.forEach(recipe => generate(recipe));

function generate(__recipe) {
    console.log(`\n******** Generate ${__recipe} ********`);
    /* Load Configuration Files */
    const recipePath = path.join(__dirname, '../recipes', __recipe, 'recipe.yaml');
    const coreJsPath = path.join(__dirname, 'core/*.js');
    const recipeJsPath = path.join(__dirname, '../recipes', __recipe, '**/*.js');

    const rawRecipe = fs.readFileSync(recipePath, 'utf8');

    const recipe = yaml.parse(rawRecipe);

    const { componentPaths, dist, path: basePath } = config;

    const packagePath = path.join(__workdir, basePath, 'package.json');
    const rawPackage = fs.readFileSync(packagePath, 'utf8');
    const package = JSON.parse(rawPackage);

    const { artifacts, templates, vars } = recipe;

    /* Initialize Store */
    const metadata = meta.generate(recipe, componentPaths.map(p => path.join(__workdir, basePath, p)));

    const _ = {
        config: JSON.parse(JSON.stringify(config)),
        js: {
            core: {}
        },
        metadata,
        package,
        recipe: JSON.parse(JSON.stringify(recipe)),
        templates: {},
    };

    /* Initialize Store: Recipe JS */
    glob.sync(recipeJsPath, {}).forEach(script => {
        console.log(`Load JS: ${script}`);

        const module = require(script);
        Object.entries(module).forEach(([key, value]) => _.js[key] = value);
    });
    console.log('Recipe functions:', Object.keys(_.js));

    /* Initialize Store: Core JS */
    glob.sync(coreJsPath, {}).forEach(script => {
        console.log(`Load JS: ${script}`);
        let module = require(script);
        if (typeof module === 'function') {
            module = module(__recipe, recipePath);
        }

        Object.entries(module).forEach(([key, value]) => _.js.core[key] = value);
    });
    console.log('Core functions:', Object.keys(_.js.core));

    /* Initialize Store: Templates */
    const variables = 'const { config, js, metadata, package, recipe, templates } = _;';

    const resolveTemplateImpl = template => new Function(
        '_',
        'target',
        'key',
        `${variables} return \`${template}\`;`
    );

    const resolveTemplate = (template, { _, value, key }) => {
        while (true) {
            try {
                const resolved = resolveTemplateImpl(template)(_, value, key);

                if (
                    !/js[.]core[.]read(Config|Recipe|Source)File/g.test(template) &&
                    !/templates[.]\w+[(]/g.test(template)
                ) {
                    return resolved;
                }

                template = resolved;
            } catch (ex) {
                return template;
            }
        }
    }

    const evaluate = value => new Function(
        '_',
        'target',
        'key',
        `${variables} return ${value};`
    );

    Object.entries(templates || {}).forEach(([key, { condition, join, template }]) => {
        return _.templates[key] = source => (source === null || source === undefined) ?
            '' :
            (condition && (console.log('condition', condition) || !evaluate(condition)(_, source))) ?
                '' :
                Array.isArray(source) ?
                    source.map((value, key) => resolveTemplate(template, { _, value, key })).join(join || '\n') :
                    Object.entries(source).map(([key, value]) => resolveTemplate(template, { _, value, key })).join(join || '\n')
    });

    /* Resolve Recipe Variables */
    function resolve(target, targetPath = []) {
        R.forEach(key => {
            const value = R.path([...targetPath, key], target);
            if (value && typeof value === 'object') {
                target = resolve(target, [...targetPath, key]);
            } else if (typeof value === 'string') {
                const r = resolveTemplate(value, { _ });
                if (r !== value) {
                    console.log([...targetPath, key]);
                    target = R.assocPath([...targetPath, key], r, target);
                }
            }
        }, R.keys(R.path(targetPath, target)));

        return target;
    }

    /* Resolve Variables */
    console.log('Resolve `config` variables');
    _.config.vars = resolve(_.config.vars[__recipe]);
    console.log('Resolve `recipe` variables');
    _.recipe.vars = resolve(_.recipe.vars);

    /* Generate Artifacts */
    const resolveArtifact = ({ condition, filepath, foreach, template, templatefile }) => {
        if (condition) {
            const res = evaluate(condition)(_);

            if (!res) {
                console.log(`Skip artifact ${filepath}. Condition evaluated to`, res)
                return [];
            }
        }

        if (!foreach) {
            return [[
                resolveTemplate(filepath, { _ }),
                resolveTemplate(template, { _ })
            ]];
        }

        const source = evaluate(foreach)(_);

        return (source === null || source === undefined) ?
            [] :
            Array.isArray(source) ?
                source.map((value, key) => {
                    const resolvedFilepath = resolveTemplate(filepath, { _, value, key });
                    const content = resolveTemplate(template, { _, value, key });

                    return [resolvedFilepath, content];
                }) :
                Object.entries(source).map(([key, value]) => {
                    const resolvedFilepath = resolveTemplate(filepath, { _, value, key });
                    const content = resolveTemplate(template, { _, value, key });

                    return [resolvedFilepath, content];
                });
    };

    const resolvedArtifacts = Array.prototype.concat(...artifacts.map(resolveArtifact));

    const distFolder = path.resolve(__workdir, _.recipe.dist);
    fs.rmdirSync(distFolder, { recursive: true });

    resolvedArtifacts.forEach(([filepath, content]) => {
        filepath = path.resolve(distFolder, filepath);

        ensureDirectoryExistence(filepath);
        fs.writeFileSync(filepath, content);
    });
}
