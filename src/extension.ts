// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { simpleGit } from 'simple-git';
import * as vscode from 'vscode';
let octokit: Octokit;
let processedCommits: Set<string> = new Set<string>();

export async function activate(context: vscode.ExtensionContext) {
    // Automatically try to initialize when the extension activates
    try {
        await initializeGitHub(context);
        vscode.window.showInformationMessage('Trackr initialized successfully!');
    } catch (error) {
        vscode.window.showErrorMessage(`Trackr initialization failed  : ${error}`);
    }

    // Also register the manual start command
    let disposable = vscode.commands.registerCommand('trackr.start', async () => {
        try {
            await initializeGitHub(context);
            vscode.window.showInformationMessage('Trackr initialized successfully !');
        } catch (error) {
            vscode.window.showErrorMessage(`Trackr initialization failed : ${error}`);
        }
    });

    context.subscriptions.push(disposable);

    // Setup git watcher
    const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/**');
    gitWatcher.onDidChange(async () => {
        if (!octokit) {
            await initializeGitHub(context);
        }
        await trackGitChange(context);
    });

    await initializeGitHub(context);
}

async function initializeGitHub(context: vscode.ExtensionContext) {
    try {
        const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
        octokit = new Octokit({ auth: session.accessToken });
        
        const user = await octokit.users.getAuthenticated();
        try {
            await octokit.repos.get({
                owner: user.data.login,
                repo: 'TrackrGitLog'
            });
        } catch {
            await octokit.repos.createForAuthenticatedUser({
                name: 'TrackrGitLog',
                description: 'Tracks all my git commits across repositories',
                private: true
            });
        }

        // Load processed commits from GitHub
        await loadProcessedCommits();

        vscode.window.showInformationMessage('Trackr: Successfully connected to GitHub!');
    } catch (error) {
        vscode.window.showErrorMessage('Failed to initialize GitHub connection');
        console.error(error);
    }
}

async function loadProcessedCommits() {
    try {
        const user = await octokit.users.getAuthenticated();
        const { data: existing } = await octokit.repos.getContent({
            owner: user.data.login,
            repo: 'TrackrGitLog',
            path: 'git.trackr.log'
        });

        if ('content' in existing) {
            const content = Buffer.from(existing.content, 'base64').toString('utf8');
            const commits = content.split('\n')
                .filter(line => line.trim()) // Filter out empty lines
                .map(line => {
                    const match = line.match(/\[(.*?)\] (.*?):/);
                    return match ? match[2] : null;
                })
                .filter(hash => hash !== null);
            
            commits.forEach(hash => processedCommits.add(hash!));
        }
    } catch (error: any) {
        if (error.status !== 404) {
            console.error('Error loading processed commits:', error);
        }
    }
}

async function trackGitChange(context: vscode.ExtensionContext) {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const currentWorkspace = workspaceFolders[0].uri.fsPath;
        const git = simpleGit(currentWorkspace);

        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            return;
        }

        const log = await git.log(['-1']);
        if (!log.latest) {return;}

        const { hash, message, date } = log.latest;

        // Skip if commit is already processed
        if (processedCommits.has(hash)) {
            return;
        }

        const logEntry = `[${date}] ${hash}: ${message}\n`;

        const user = await octokit.users.getAuthenticated();
        
        try {
            let content: string;
            let sha: string | undefined;

            try {
                const { data: existing } = await octokit.repos.getContent({
                    owner: user.data.login,
                    repo: 'TrackrGitLog',
                    path: 'git.trackr.log'
                });

                if ('content' in existing && 'sha' in existing) {
                    const buff = Buffer.from(existing.content, 'base64');
                    content = buff.toString('utf8');
                    sha = existing.sha;
                } else {
                    content = '';
                }
            } catch (error: any) {
                if (error.status === 404) {
                    content = '';
                } else {
                    throw error;
                }
            }

            content = content + logEntry;

            const logFile = path.join(os.homedir(), 'git.trackr.log');
            fs.writeFileSync(logFile, content);

            await octokit.repos.createOrUpdateFileContents({
                owner: user.data.login,
                repo: 'TrackrGitLog',
                path: 'git.trackr.log',
                message: sha ? 'Update git.trackr.log' : 'Create git.trackr.log',
                content: Buffer.from(content).toString('base64'),
                sha: sha
            });

            // Add to processed commits and persist
            processedCommits.add(hash);
            await context.workspaceState.update('processedCommits', Array.from(processedCommits));

            vscode.window.showInformationMessage(`Tracked commit: ${message}`);
        } catch (error: any) {
            if (error.status === 409) {
                console.log('Conflict detected, retrying...');
                await trackGitChange(context);
            } else {
                throw error;
            }
        }
    } catch (error) {
        console.error('Error tracking git change:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to track git change: ${errorMessage}`);
    }
}

export function deactivate() {}