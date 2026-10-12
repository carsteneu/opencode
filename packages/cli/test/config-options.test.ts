import { expect, test } from "bun:test"
import { configOptions } from "../src/server-process"

test("configOptions leaves global config enabled unless an env opts out", () => {
  expect(configOptions({}).global).toBeUndefined()
  expect(configOptions({ OPENCODE_CONFIG_GLOBAL_DISABLE: "1" }).global).toBe(false)
  expect(configOptions({ OPENCODE_DISABLE_GLOBAL_CONFIG: "true" }).global).toBe(false)
  expect(configOptions({ OPENCODE_CONFIG_GLOBAL_DISABLE: "0" }).global).toBeUndefined()
  expect(configOptions({ OPENCODE_CONFIG_GLOBAL_DISABLE: "false" }).global).toBeUndefined()
})

test("configOptions still resolves directory, project, file and content", () => {
  const options = configOptions({
    OPENCODE_CONFIG_DIR: "/tmp/config",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_CONFIG: "/tmp/opencode.json",
    OPENCODE_CONFIG_CONTENT: "{}",
  })
  expect(options.directory).toBe("/tmp/config")
  expect(options.project).toBe(false)
  expect(options.file).toBe("/tmp/opencode.json")
  expect(options.content).toBe("{}")
})
