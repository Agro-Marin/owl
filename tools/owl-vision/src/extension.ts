import * as vscode from 'vscode';
import { Search } from './search';
import { OpenDirection } from './utils';
import { OwlLanguageFeaturesProvider } from './language_features/language_features_provider';
import { TemplateTypeChecker } from './template_types/checker';

export async function activate(context: vscode.ExtensionContext) {
    const search = new Search();
    context.subscriptions.push(vscode.commands.registerCommand('owl-vision.switch', () => search.switch()));
    context.subscriptions.push(vscode.commands.registerCommand('owl-vision.switch-besides', () => search.switch(OpenDirection.Besides)));
    context.subscriptions.push(vscode.commands.registerCommand('owl-vision.switch-below', () => search.switch(OpenDirection.Below)));
    context.subscriptions.push(vscode.commands.registerCommand('owl-vision.find-component', () => search.findComponentCommand()));
    context.subscriptions.push(vscode.commands.registerCommand('owl-vision.find-template', () => search.findTemplateCommand()));

    const languageFeaturesProvider = new OwlLanguageFeaturesProvider(search);
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'xml', scheme: 'file' }, languageFeaturesProvider, '.', '<'));
    context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'xml', scheme: 'file' }, languageFeaturesProvider));

    const checker = new TemplateTypeChecker();
    context.subscriptions.push(checker);
    context.subscriptions.push(vscode.commands.registerCommand('owl-vision.check-templates', () => checker.run()));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
        if (/\.(xml|js|mjs|ts)$/.test(document.fileName)) {
            checker.schedule();
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('owl-vision.templateTypes')) {
            checker.run();
        }
    }));
    checker.run();
}

export function deactivate() { }
