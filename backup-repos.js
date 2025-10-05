#!/usr/bin/env node

/**
 * GitHub Organization Repository Backup Script
 * Clones all repos from source org and mirrors them to backup org
 */

const { Octokit } = require('@octokit/rest');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const SOURCE_ORG = process.env.SOURCE_ORG;
const BACKUP_ORG = process.env.BACKUP_ORG;
const SOURCE_TOKEN = process.env.SOURCE_TOKEN;
const BACKUP_TOKEN = process.env.BACKUP_TOKEN;
const BACKUP_SCRIPT_REPO = process.env.BACKUP_SCRIPT_REPO || 'github-org-backup'; // Repo name that contains this script

function validateConfig() {
  if (!SOURCE_ORG || !BACKUP_ORG || !SOURCE_TOKEN || !BACKUP_TOKEN) {
    console.error('❌ Missing required environment variables');
    process.exit(1);
  }
  console.log(`🔒 Protected repo: ${BACKUP_SCRIPT_REPO} (will not be deleted)\n`);
}

function executeCommand(command, cwd = process.cwd()) {
  try {
    execSync(command, { 
      cwd, 
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return true;
  } catch (error) {
    console.error(`  ❌ Command failed: ${error.message}`);
    return false;
  }
}

async function deleteBackupRepo(backupOctokit, repoName) {
  try {
    // Check if repo exists first
    await backupOctokit.repos.get({
      owner: BACKUP_ORG,
      repo: repoName
    });
    
    console.log(`  → Deleting existing backup...`);
    await backupOctokit.repos.delete({
      owner: BACKUP_ORG,
      repo: repoName
    });
    console.log(`  ✓ Deleted old backup`);
    // Wait a bit for GitHub to process the deletion
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch (error) {
    if (error.status === 404) {
      console.log(`  ℹ No existing backup to delete`);
      return true;
    }
    if (error.status === 403) {
      console.log(`  ⚠️  Cannot delete (permission issue) - will use force push instead`);
      return 'force-push';
    }
    console.error(`  ❌ Failed to delete: ${error.message}`);
    return false;
  }
}

async function cloneAndMirrorRepo(repo, backupOctokit, tempDir) {
  const repoName = repo.name;
  console.log(`\n📦 Processing: ${repoName}`);

  // Skip the backup script repo
  if (repoName === BACKUP_SCRIPT_REPO) {
    console.log(`  🔒 Skipping protected repo (contains backup script)`);
    return true;
  }

  try {
    // Delete existing backup repo first
    const deleteResult = await deleteBackupRepo(backupOctokit, repoName);
    
    if (deleteResult === false) {
      return false;
    }

    let backupRepo;
    const useExisting = deleteResult === 'force-push';

    if (useExisting) {
      // Repo exists and we can't delete it, so we'll use it
      const { data } = await backupOctokit.repos.get({
        owner: BACKUP_ORG,
        repo: repoName
      });
      backupRepo = data;
      console.log(`  ✓ Using existing backup repo: ${backupRepo.html_url}`);
    } else {
      // Create fresh backup repository
      console.log(`  → Creating backup repository...`);
      const { data } = await backupOctokit.repos.createInOrg({
        org: BACKUP_ORG,
        name: repoName,
        description: `[BACKUP] ${repo.description || 'No description'}`,
        private: repo.private,
        has_issues: false,
        has_wiki: false,
        has_projects: false
      });
      backupRepo = data;
      console.log(`  ✓ Created: ${backupRepo.html_url}`);
    }

    // Clone source repository (bare clone for mirroring)
    const clonePath = path.join(tempDir, repoName);
    const cloneUrl = `https://${SOURCE_TOKEN}@github.com/${SOURCE_ORG}/${repoName}.git`;
    
    console.log(`  → Cloning source repository...`);
    if (!executeCommand(`git clone --mirror ${cloneUrl} ${clonePath}`)) {
      return false;
    }

    // Push to backup repository
    const backupUrl = `https://${BACKUP_TOKEN}@github.com/${BACKUP_ORG}/${repoName}.git`;
    
    console.log(`  → Pushing to backup...`);
    if (!executeCommand(`git push --mirror ${backupUrl}`, clonePath)) {
      // If push fails, delete the empty repo we just created
      await deleteBackupRepo(backupOctokit, repoName);
      return false;
    }

    console.log(`  ✅ Successfully backed up ${repoName}`);
    return true;

  } catch (error) {
    console.error(`  ❌ Error backing up ${repoName}: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log(`🚀 GitHub Organization Backup`);
  console.log(`📅 Started at: ${new Date().toISOString()}`);
  console.log(`📂 Source Org: ${SOURCE_ORG}`);
  console.log(`💾 Backup Org: ${BACKUP_ORG}\n`);

  validateConfig();

  // Initialize Octokit clients
  const sourceOctokit = new Octokit({ auth: SOURCE_TOKEN });
  const backupOctokit = new Octokit({ auth: BACKUP_TOKEN });

  // Get source organization repositories
  let repos;
  try {
    const { data } = await sourceOctokit.repos.listForOrg({
      org: SOURCE_ORG,
      per_page: 100,
      type: 'all'
    });
    repos = data;
    console.log(`📊 Found ${repos.length} repositories to backup\n`);
  } catch (error) {
    console.error(`❌ Failed to access source organization: ${error.message}`);
    process.exit(1);
  }

  // Create temporary directory for cloning
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-backup-'));
  
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  try {
    for (const repo of repos) {
      // Skip backup script repo
      if (repo.name === BACKUP_SCRIPT_REPO) {
        console.log(`\n📦 ${repo.name} (backup script) - protected, skipping`);
        skippedCount++;
        continue;
      }

      if (repo.archived) {
        console.log(`\n📦 ${repo.name} (archived) - skipping`);
        skippedCount++;
        continue;
      }

      if (await cloneAndMirrorRepo(repo, backupOctokit, tempDir)) {
        successCount++;
      } else {
        failedCount++;
      }
    }
  } finally {
    // Cleanup temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Successfully backed up: ${successCount}`);
  console.log(`⏭️  Skipped: ${skippedCount}`);
  console.log(`❌ Failed: ${failedCount}`);
  console.log(`📅 Completed at: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});