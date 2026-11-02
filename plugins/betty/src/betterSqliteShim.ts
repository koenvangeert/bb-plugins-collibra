import { DatabaseSync } from 'node:sqlite'

export default class Database extends DatabaseSync {
  pragma(source: string): unknown[] {
    return this.prepare(`PRAGMA ${source}`).all()
  }

  transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
    return (...args) => {
      this.exec('BEGIN')
      try {
        const result = fn(...args)
        this.exec('COMMIT')
        return result
      } catch (error) {
        this.exec('ROLLBACK')
        throw error
      }
    }
  }
}
