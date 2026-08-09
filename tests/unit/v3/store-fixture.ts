import { Database } from "bun:sqlite"
import { groupKey, taskKey, type ObjectDomainSnapshot } from "../../../src/v3/object-domain"

export function insertObjectDomainFixture(databaseFile: string, snapshot: ObjectDomainSnapshot): void {
	const db = new Database(databaseFile, { strict: true })
	try {
		db.transaction(() => {
			db.query("INSERT INTO v3_chains (chain_key,payload) VALUES ($key,$payload)").run({ key: snapshot.chain.value, payload: JSON.stringify(snapshot.chain) })
			for (const group of Object.values(snapshot.groups)) db.query("INSERT INTO v3_groups (group_key,chain_key,payload) VALUES ($key,$chain,$payload)").run({ key: groupKey(group.identity), chain: snapshot.chain.value, payload: JSON.stringify(group) })
			for (const task of Object.values(snapshot.tasks)) db.query("INSERT INTO v3_tasks (task_key,chain_key,group_key,payload) VALUES ($key,$chain,$group,$payload)").run({ key: taskKey(task.identity), chain: snapshot.chain.value, group: groupKey(task.group), payload: JSON.stringify(task) })
			for (const record of Object.values(snapshot.awaits)) db.query("INSERT INTO v3_awaits (await_key,chain_key,payload) VALUES ($key,$chain,$payload)").run({ key: `${taskKey(record.identity.parent)}/${record.identity.attempt}/${record.identity.site}`, chain: snapshot.chain.value, payload: JSON.stringify(record) })
			for (const [key, task] of Object.entries(snapshot.admittedFacts)) db.query("INSERT INTO v3_facts (fact_key,chain_key,task_key) VALUES ($fact,$chain,$task)").run({ fact: key, chain: snapshot.chain.value, task: taskKey(task) })
		})()
	} finally { db.close() }
}
