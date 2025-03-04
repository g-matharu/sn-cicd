const Promise = require('bluebird');
const path = require('path');
const ExeJob = require('../eb/job');
const QueueJob = require('../eb/queue-job');

/**
 * Build has completed, called from GULP process
 * Mapped to: /build/complete
 *
 * This might trigger internally the deployment of the update-set
 *
 * @param {Object} param
 * @param {*} param.runId id of the current run
 * @param {*} param.buildResult the build results
 * @param {Console} logger a logger to be used
 * @param {Object} job job object 
 * @returns {Promise}
 */
module.exports = function ({ runId, buildResult }, logger = console, { host }) {
    const self = this;
    let config = {};
    let run;
    const slack = self.getSlack();

    const step = (message, error) => {
        return self.addStep(logger, config, `${path.basename(__filename).split('.')[0]} : ${message}`, error);
    };

    return Promise.try(() => {
        return self.db.run.get(runId).then((_run) => {
            if (!_run)
                throw Error(`Run not found with id ${runId}`);
            run = _run;
            config = _run.config;
        });
    }).then(() => {
        /* 
            check if either one gulp task failed (run.buildResults[name])
            or if it failed at the end (buildResult[name].testPass)
        */
        const buildPass = Object.keys(run.build).every((name) => {
            const buildTask = run.build[name];
            if (buildTask.enabled === true && run.build[name].breakOnError === true) {
                return buildResult[name].testPass == true;
            }
            return true;
        });
        run.buildPass = buildPass;
        return self.db.run.update(run);
    }).then(() => {
        if (!run.buildPass) {
            return self.setProgress(config, self.build.FAILED).then(() => {
                return slack.build.failed(`*${run.config.application.name} › ${run.config.updateSet.name} › #${run.sequence}*\nBUILD - Failed.\n\nBuild for <${config.application.docUri}|${config.updateSet.name}> did not pass!\n\n<${run.config.application.docUri}|details>`);
            }).then(() => {
                return self.setRunState(run, self.run.BUILD_FAILED);
            }).then(() => {
                const requestor = config.build.requestor;
                return self.email.onBuildFailure({
                    recipient: `"${requestor.fullName}" <${requestor.email}>`,
                    data: {
                        sequence: run.sequence,
                        sourceUpdateSetName: config.updateSet.name,
                        sourceUpdateSetID: config.updateSet.sys_id,
                        sourceUpdateSetUrl: self.link(config.host.name, `sys_update_set.do?sys_id=${config.updateSet.sys_id}`),
                        docUri: config.application.docUri
                    }
                });

            });
        }

        if (run.buildPass) {
            return Promise.try(() => {
                return self.setRunState(run, self.run.BUILD_COMPLETED);
            }).then(async () => {
                if (config.git.enabled && config.git.pullRequestEnabled) {

                    const us = await self.db.us.get({ _id: run.usId });
                    if (us && us.pullRequestRaised) { // in case of re-run, don't raise the PR again
                        await step('WARN: Pull request already raised!');
                        return;
                    }

                    await step(`set update-set status to ${self.build.CODE_REVIEW_PENDING}`);
                    await self.setProgress(config, self.build.CODE_REVIEW_PENDING);

                    await step('raise pull request');
                    try {
                        await self.raisePullRequest({
                            config: config,
                            requestor: config.build.requestor.userName,
                            repoName: config.git.repository,
                            from: config.branchName,
                            to: config.master.name || 'master',
                            title: `${config.application.name} › ${config.updateSet.name} › #${config.build.sequence} (${config.build.requestor.fullName})`,
                            description: `${config.updateSet.description}\n\nBuild Results: ${config.application.docUri}\n\nCompleted-By: ${config.build.requestor.fullName} (${config.build.requestor.userName})\nCompleted-On: ${config.updateSet.sys_updated_on} UTC\n${self.link(config.host.name, `/sys_update_set.do?sys_id=${config.updateSet.sys_id}`)}`
                        });

                        await step('pull request raised');
                        await self.db.us.update({ _id: run.usId, pullRequestRaised: true });
                        await self.setRunState(run, self.run.PULL_REQUEST_RAISED);

                    } catch (e) {
                        await step(`Pull request creation failed with: ${e.message}`);
                    }

                } else if (config.deploy && config.deploy.enabled && config.deploy.onBuildPass) { // deploy the update set
                    // run deployment via wrapper
                    return self.setRunState(run, self.run.SUCCESSFUL).then(async () => {

                        /*
                        const deploymentWrapper = require('../deployment-wrapper');
                        return deploymentWrapper.run.call(self, { commitId: run.commitId, deploy: true }, logger);
                        */
                        const job = await new ExeJob({ name: 'deploy', background: true, exclusiveId: `deploy-${run.commitId}`, description: `Deploy ${config.application.name} : ${config.updateSet.name} : ${run.commitId}` },
                            { commitId: run.commitId, deploy: true }, logger);
                        console.log(`Deployment job started. JobId: ${job._id}`);
                    });

                } else {
                    return self.setProgress(config, self.build.COMPLETE).then(() => {
                        return self.setRunState(run, self.run.SUCCESSFUL);
                    }).then(() => {
                        return slack.build.complete(`*${run.config.application.name} › ${run.config.updateSet.name} › #${run.sequence}*\nBUILD - Completed.\n\nBuild successfully completed for Update-Set <${self.link(config.host.name, `/sys_update_set.do?sys_id=${config.updateSet.sys_id}`)}|${config.updateSet.name}>\n\n<${run.config.application.docUri}|details>`);
                    });
                }
            });
        }
    });
};
