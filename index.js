const dotenv = require('dotenv')
dotenv.config()

const express = require('express')
const execa = require('execa')
const { Octokit } = require('@octokit/rest')
const configs = require('./config.json')
const utils = require('./utils')

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN
const PORT = process.env.PORT || 3000


const octokit = new Octokit({ auth: GITHUB_ACCESS_TOKEN })
const app = express()
app.disable('x-powered-by')
app.use(express.json())

app.use((req, res, next) => {
  if (utils.verifySignature(req, JSON.stringify(req.body), GITHUB_WEBHOOK_SECRET)) {
    next()
  } else {
    res.sendStatus(500)
  }
})

app.post('/', (req, res) => {
  const eventType = req.header('X-GitHub-Event')
  res.sendStatus(200)

  return handleEvent(eventType, req.body)
    .catch(err => {
      console.error(err)
    })
})

async function handleEvent (eventType, payload) {
    const config = configs[payload.repository.full_name]
    if (eventType === 'release') {
        if (payload.action === 'published') {
            // We just updated the code and run everything
            return deploy(config, payload.release.tag_name, payload.repository.clone_url)
        } else if (payload.action === 'deleted') {
            // This is a rollback, we are going to get the latest release from GitHub and check that out
            const repsonse = await octokit.repos.getLatestRelease({
                owner: payload.repository.owner.login,
                repo: payload.repository.name 
            })
            if (repsonse.status !== 200) {
                throw new Error(`Unable to get latest release for "${payload.repository.full_name}"`)
            }
            return deploy(config, repsonse.data.tag_name, payload.repository.clone_url)
        }
    } else if (eventType === 'push' && config.deployAllCommits && payload.ref === 'refs/heads/' + config.deployAllCommits) {
        // We only do this if the config is setup AND if the pushed branch matches.
        return deploy(config, undefined, payload.repository.clone_url)
    }
}

let currentCommands = {}
async function execute (pm2Id, file, args, options) {
    const subprocess = execa(file, args, options);
    currentCommands[pm2Id] = subprocess
    return subprocess
}

async function executeCommand (pm2Id, command, options) {
    const subprocess = execa.command(command, options);
    currentCommands[pm2Id] = subprocess
    return subprocess
}

async function deploy (config, tag, cloneUrl) {
    if (currentCommands[config.name] !== undefined) {
        await currentCommands[config.name].cancel()
    }

    try {
        const url = cloneUrl.replace('https://github.com', 'https://' + GITHUB_ACCESS_TOKEN + '@github.com')
        await execute(config.name, 'git', ['fetch', url, '--tags'], { cwd: config.path })
        if (tag) {
            await execute(config.name, 'git', ['checkout', tag], { cwd: config.path })
        } else {
            await execute(config.name, 'git', ['checkout', config.deployAllCommits], { cwd: config.path })
        }
        if (config.pre) {
            for (const pre of config.pre) {
                await executeCommand(config.name, pre, { cwd: config.path })
            }
        }
        await execute(config.name, 'pm2', ['restart', config.name])
    } catch (e) {
        if (e.isCanceled) {
            return Promise.resolve()
        } else {
            throw e
        }
    }

    return Promise.resolve()
}

app.listen(PORT, () => console.log(`Listening to port ${PORT}`))