// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


// module dependencies
const axios = require('axios');
const yaml = require('js-yaml');
const status = require('statuses');
const runtimeEnv = require('./runtime-env');
const launcherConfig = require('@pai/config/launcher');
const createError = require('@pai/utils/error');


const convertName = (name) => {
  // convert framework name to fit framework controller spec
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
};

const encodeName = (name) => {
  if (name.startsWith('unknown') || !name.includes('~')) {
    // framework is not generated by PAI
    return convertName(name.replace(/^unknown/g, ''));
  } else {
    // hex encode and add "hex" prefix
    return `hex${Buffer.from(name).toString('hex')}`;
  }
};

const decodeName = (name) => {
  if (name.startsWith('hex')) {
    // remove "hex" prefix and hex decode
    const frameworkName = Buffer.from(name.replace(/^hex/g, ''), 'hex').toString('ascii');
    return frameworkName.split(/~(.+)/)[1];
  } else {
    // framework name has not been encoded
    return name;
  }
};

const convertState = (state, exitCode) => {
  switch (state) {
    case 'AttemptCreationPending':
    case 'AttemptCreationRequested':
    case 'AttemptPreparing':
      return 'WAITING';
    case 'AttemptRunning':
      return 'RUNNING';
    case 'AttemptDeletionPending':
    case 'AttemptDeletionRequested':
    case 'AttemptDeleting':
    case 'AttemptCompleted':
      return 'WAITING';
    case 'Completed':
      if (exitCode === 0) {
        return 'SUCCEEDED';
      } else {
        return 'FAILED';
      }
    default:
      return 'UNKNOWN';
  }
};

const convertFrameworkSummary = (framework) => {
  const completionStatus = framework.status.attemptStatus.completionStatus;
  return {
    name: decodeName(framework.metadata.name),
    username: framework.metadata.labels ? framework.metadata.labels.userName : 'unknown',
    state: convertState(framework.status.state, completionStatus ? completionStatus.code : null),
    subState: framework.status.state,
    executionType: framework.spec.executionType.toUpperCase(),
    retries: framework.status.retryPolicyStatus.totalRetriedCount,
    retryDetails: {
      user: framework.status.retryPolicyStatus.accountableRetriedCount,
      platform: framework.status.retryPolicyStatus.totalRetriedCount - framework.status.retryPolicyStatus.accountableRetriedCount,
      resource: 0,
    },
    createdTime: new Date(framework.status.startTime).getTime(),
    completedTime: new Date(framework.status.completionTime).getTime(),
    appExitCode: completionStatus ? completionStatus.code : null,
    virtualCluster: framework.metadata.labels ? framework.metadata.labels.virtualCluster : 'unknown',
    totalGpuNumber: 0, // TODO
    totalTaskNumber: framework.status.attemptStatus.taskRoleStatuses.reduce(
      (num, statuses) => num + statuses.taskStatuses.length, 0),
    totalTaskRoleNumber: framework.status.attemptStatus.taskRoleStatuses.length,
  };
};

const convertTaskDetail = (taskStatus) => {
  const completionStatus = taskStatus.attemptStatus.completionStatus;
  return {
    taskIndex: taskStatus.index,
    taskState: convertState(taskStatus.state, completionStatus ? completionStatus.code : null),
    containerId: taskStatus.attemptStatus.podName,
    containerIp: taskStatus.attemptStatus.podHostIP,
    containerPorts: {}, // TODO
    containerGpus: 0, // TODO
    containerLog: '',
    containerExitCode: completionStatus ? completionStatus.code : null,
  };
};

const convertFrameworkDetail = (framework) => {
  const completionStatus = framework.status.attemptStatus.completionStatus;
  const detail = {
    name: decodeName(framework.metadata.name),
    jobStatus: {
      username: framework.metadata.labels ? framework.metadata.labels.userName : 'unknown',
      state: convertState(framework.status.state, completionStatus ? completionStatus.code : null),
      subState: framework.status.state,
      executionType: framework.spec.executionType.toUpperCase(),
      retries: framework.status.retryPolicyStatus.totalRetriedCount,
      retryDetails: {
        user: framework.status.retryPolicyStatus.accountableRetriedCount,
        platform: framework.status.retryPolicyStatus.totalRetriedCount - framework.status.retryPolicyStatus.accountableRetriedCount,
        resource: 0,
      },
      createdTime: new Date(framework.status.startTime).getTime(),
      completedTime: new Date(framework.status.completionTime).getTime(),
      appId: framework.status.attemptStatus.instanceUID,
      appProgress: completionStatus ? 1 : 0,
      appTrackingUrl: '',
      appLaunchedTime: new Date(framework.status.startTime).getTime(),
      appCompletedTime: new Date(framework.status.completionTime).getTime(),
      appExitCode: completionStatus ? completionStatus.code : null,
      appExitSpec: {}, // TODO
      appExitDiagnostics: completionStatus ? completionStatus.diagnostics : null,
      appExitMessages: {
        container: null,
        runtime: null,
        launcher: null,
      },
      appExitTriggerMessage: completionStatus ? completionStatus.diagnostics : null,
      appExitTriggerTaskRoleName: null, // TODO
      appExitTriggerTaskIndex: null, // TODO
      appExitType: completionStatus ? completionStatus.type.name : null,
      virtualCluster: framework.metadata.labels ? framework.metadata.labels.virtualCluster : 'unknown',
    },
    taskRoles: {},
  };
  for (let taskRoleStatus of framework.status.attemptStatus.taskRoleStatuses) {
    detail.taskRoles[taskRoleStatus.name] = {
      taskRoleStatus: {
        name: taskRoleStatus.name,
      },
      taskStatuses: taskRoleStatus.taskStatuses.map(convertTaskDetail),
    };
  }
  return detail;
};

const generateTaskRole = (taskRole, labels, config) => {
  const frameworkTaskRole = {
    name: convertName(taskRole),
    taskNumber: config.taskRoles[taskRole].instances || 1,
    task: {
      retryPolicy: {
        fancyRetryPolicy: true,
        maxRetryCount: 0,
      },
      pod: {
        metadata: {
          labels: {
            ...labels,
            type: 'kube-launcher-task',
          },
          annotations: {
            'container.apparmor.security.beta.kubernetes.io/main': 'unconfined',
          },
        },
        spec: {
          privileged: false,
          restartPolicy: 'Never',
          serviceAccountName: 'frameworkbarrier',
          initContainers: [
            {
              name: 'init',
              imagePullPolicy: 'Always',
              image: launcherConfig.runtimeImage,
              env: [
                {
                  name: 'USER_CMD',
                  value: config.taskRoles[taskRole].entrypoint,
                },
                {
                  name: 'KUBE_APISERVER_ADDRESS',
                  value: launcherConfig.apiServerUri,
                },
              ],
              volumeMounts: [
                {
                  name: 'pai-vol',
                  mountPath: '/usr/local/pai',
                },
                {
                  name: 'host-log',
                  mountPath: '/usr/local/pai/logs',
                },
              ],
            },
          ],
          containers: [
            {
              name: 'main',
              image: config.prerequisites.dockerimage[config.taskRoles[taskRole].dockerImage].uri,
              command: ['/usr/local/pai/run'],
              resources: {
                limits: {
                  'cpu': config.taskRoles[taskRole].resourcePerInstance.cpu,
                  'memory': `${config.taskRoles[taskRole].resourcePerInstance.memoryMB}Mi`,
                  'nvidia.com/gpu': config.taskRoles[taskRole].resourcePerInstance.gpu,
                },
              },
              env: [],
              securityContext: {
                capabilities: {
                  add: ['SYS_ADMIN', 'IPC_LOCK', 'DAC_READ_SEARCH'],
                  drop: ['MKNOD'],
                },
              },
              volumeMounts: [
                {
                  name: 'pai-vol',
                  mountPath: '/usr/local/pai',
                },
                {
                  name: 'host-log',
                  mountPath: '/usr/local/pai/logs',
                },
                {
                  name: 'job-ssh-secret-volume',
                  readOnly: true,
                  mountPath: '/usr/local/pai/ssh-secret',
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'pai-vol',
              emptyDir: {},
            },
            {
              name: 'host-log',
              hostPath: {
                path: `/var/log/pai/${labels.userName}/${labels.jobName}/${taskRole}`,
              },
            },
            {
              name: 'job-ssh-secret-volume',
              secret: {
                secretName: 'job-ssh-secret',
              },
            },
          ],
          imagePullSecrets: [
            {
              name: launcherConfig.runtimeImagePullSecrets,
            },
          ],
          hostNetwork: true,
        },
      },
    },
  };
  // fill in completion policy
  if ('completion' in config.taskRoles[taskRole]) {
    frameworkTaskRole.frameworkAttemptCompletionPolicy = {
      minFailedTaskCount: ('minFailedInstances' in config.taskRoles[taskRole].completion) ?
        config.taskRoles[taskRole].completion.minFailedInstances : 1,
      minSucceededTaskCount: ('minSucceededInstances' in config.taskRoles[taskRole].completion) ?
        config.taskRoles[taskRole].completion.minSucceededInstances : -1,
    };
  } else {
    frameworkTaskRole.frameworkAttemptCompletionPolicy = {
      minFailedTaskCount: 1,
      minSucceededTaskCount: -1,
    };
  }
  // hived spec
  if (launcherConfig.enabledHived) {
    frameworkTaskRole.task.pod.spec.schedulerName = launcherConfig.scheduler;

    delete frameworkTaskRole.task.pod.spec.containers[0].resources.limits['nvidia.com/gpu'];
    frameworkTaskRole.task.pod.spec.containers[0]
      .resources.limits['hivedscheduler.microsoft.com/pod-scheduling-enable'] = 1;
    frameworkTaskRole.task.pod.metadata.annotations['hivedscheduler.microsoft.com/pod-scheduling-spec'] = yaml.safeDump(config.taskRoles[taskRole].hivedPodSpec);
    frameworkTaskRole.task.pod.spec.containers[0].env.push(
      {
        name: 'NVIDIA_VISIBLE_DEVICES',
        valueFrom: {
          fieldRef: {
            fieldPath: `metadata.annotations['hivedscheduler.microsoft.com/pod-gpu-isolation']`,
          },
        },
      });
  }

  return frameworkTaskRole;
};

const generateFrameworkDescription = (frameworkName, virtualCluster, config, rawConfig) => {
  const [userName, jobName] = frameworkName.split(/~(.+)/);
  const frameworkLabels = {
    jobName,
    userName,
    virtualCluster,
  };
  const frameworkDescription = {
    apiVersion: launcherConfig.apiVersion,
    kind: 'Framework',
    metadata: {
      name: encodeName(frameworkName),
      labels: frameworkLabels,
      annotations: {
        config: rawConfig,
      },
    },
    spec: {
      executionType: 'Start',
      retryPolicy: {
        fancyRetryPolicy: (config.jobRetryCount !== -2),
        maxRetryCount: config.jobRetryCount || 0,
      },
      taskRoles: [],
    },
  };
  // generate runtime env
  const env = runtimeEnv.generateFrameworkEnv(frameworkName, config);
  const envlist = Object.keys(env).map((name) => {
    return {name, value: `${env[name]}`};
  });
  // fill in task roles
  for (let taskRole of Object.keys(config.taskRoles)) {
    const taskRoleDescription = generateTaskRole(taskRole, frameworkLabels, config);
    taskRoleDescription.task.pod.spec.containers[0].env.push(...envlist.concat([
      {
        name: 'PAI_CURRENT_TASK_ROLE_NAME',
        valueFrom: {
          fieldRef: {
            fieldPath: `metadata.annotations['FC_TASKROLE_NAME']`,
          },
        },
      },
      {
        name: 'PAI_CURRENT_TASK_ROLE_CURRENT_TASK_INDEX',
        valueFrom: {
          fieldRef: {
            fieldPath: `metadata.annotations['FC_TASK_INDEX']`,
          },
        },
      },
      // backward compatibility
      {
        name: 'PAI_TASK_INDEX',
        valueFrom: {
          fieldRef: {
            fieldPath: `metadata.annotations['FC_TASK_INDEX']`,
          },
        },
      },
      // use random ports temporally
      {
        name: 'PAI_CURRENT_CONTAINER_PORT',
        value: `${Math.floor((Math.random() * 10000) + 10000)}`,
      },
      {
        name: 'PAI_CONTAINER_SSH_PORT',
        value: `${Math.floor((Math.random() * 10000) + 10000)}`,
      },
    ]));
    frameworkDescription.spec.taskRoles.push(taskRoleDescription);
  }
  return frameworkDescription;
};


const list = async () => {
  // send request to framework controller
  let response;
  try {
    response = await axios({
      method: 'get',
      url: launcherConfig.frameworksPath(),
      headers: launcherConfig.requestHeaders,
    });
  } catch (error) {
    if (error.response != null) {
      response = error.response;
    } else {
      throw error;
    }
  }

  if (response.status === status('OK')) {
    const frameworkList = response.data.items.map(convertFrameworkSummary);
    frameworkList.sort((a, b) => b.createdTime - a.createdTime);
    return frameworkList;
  } else {
    throw createError(response.status, 'UnknownError', response.data.message);
  }
};

const get = async (frameworkName) => {
  // send request to framework controller
  let response;
  try {
    response = await axios({
      method: 'get',
      url: launcherConfig.frameworkPath(encodeName(frameworkName)),
      headers: launcherConfig.requestHeaders,
    });
  } catch (error) {
    if (error.response != null) {
      response = error.response;
    } else {
      throw error;
    }
  }

  if (response.status === status('OK')) {
    return convertFrameworkDetail(response.data);
  }
  if (response.status === status('Not Found')) {
    throw createError('Not Found', 'NoJobError', `Job ${frameworkName} is not found.`);
  } else {
    throw createError(response.status, 'UnknownError', response.data.message);
  }
};

const put = async (frameworkName, config, rawConfig) => {
  const virtualCluster = ('defaults' in config && config.defaults.virtualCluster != null) ?
    config.defaults.virtualCluster : 'default';

  const frameworkDescription = generateFrameworkDescription(frameworkName, virtualCluster, config, rawConfig);

  // send request to framework controller
  let response;
  try {
    response = await axios({
      method: 'post',
      url: launcherConfig.frameworksPath(),
      headers: launcherConfig.requestHeaders,
      data: frameworkDescription,
    });
  } catch (error) {
    if (error.response != null) {
      response = error.response;
    } else {
      throw error;
    }
  }
  if (response.status !== status('Created')) {
    throw createError(response.status, 'UnknownError', response.data.message);
  }
};

const execute = async (frameworkName, executionType) => {
  // send request to framework controller
  let response;
  try {
    response = await axios({
      method: 'patch',
      url: launcherConfig.frameworkPath(encodeName(frameworkName)),
      headers: {
        'Content-Type': 'application/merge-patch+json',
      },
      data: {
        spec: {
          executionType: `${executionType.charAt(0)}${executionType.slice(1).toLowerCase()}`,
        },
      },
    });
  } catch (error) {
    if (error.response != null) {
      response = error.response;
    } else {
      throw error;
    }
  }
  if (response.status !== status('OK')) {
    throw createError(response.status, 'UnknownError', response.data.message);
  }
};

const getConfig = async (frameworkName) => {
  // send request to framework controller
  let response;
  try {
    response = await axios({
      method: 'get',
      url: launcherConfig.frameworkPath(encodeName(frameworkName)),
      headers: launcherConfig.requestHeaders,
    });
  } catch (error) {
    if (error.response != null) {
      response = error.response;
    } else {
      throw error;
    }
  }

  if (response.status === status('OK')) {
    if (response.data.metadata.annotations && response.data.metadata.annotations.config) {
      return yaml.safeLoad(response.data.metadata.annotations.config);
    } else {
      throw createError('Not Found', 'NoJobConfigError', `Config of job ${frameworkName} is not found.`);
    }
  }
  if (response.status === status('Not Found')) {
    throw createError('Not Found', 'NoJobError', `Job ${frameworkName} is not found.`);
  } else {
    throw createError(response.status, 'UnknownError', response.data.message);
  }
};

const getSshInfo = async (frameworkName) => {
  throw createError('Not Found', 'NoJobSshInfoError', `SSH info of job ${frameworkName} is not found.`);
};


// module exports
module.exports = {
  list,
  get,
  put,
  execute,
  getConfig,
  getSshInfo,
};
