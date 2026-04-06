import { PrivateKey, Utils, SignedMessage } from '@bsv/sdk'

// JSON-RPC 2.0 Message Types for A2A
export type A2AMessageType = 
  | 'agent/discover' 
  | 'agent/negotiate' 
  | 'agent/delegate' 
  | 'agent/status' 
  | 'agent/complete'

export interface JSONRPCRequest<T = any> {
  jsonrpc: '2.0'
  id: string | number
  method: A2AMessageType
  params: T
  signature?: string // BRC-103 signature
  pubkey?: string
}

export interface JSONRPCResponse<T = any> {
  jsonrpc: '2.0'
  id: string | number
  result?: T
  error?: {
    code: number
    message: string
    data?: any
  }
  signature?: string
  pubkey?: string
}

export type TaskState = 'submitted' | 'working' | 'completed' | 'failed'

export interface TaskStatusUpdate {
  taskId: string
  state: TaskState
  progress: number
  artifact?: string // SSE streamed artifact chunk (e.g. partial translation)
}

export class A2AProtocol {
  private privateKey: PrivateKey

  constructor(privateKey: PrivateKey) {
    this.privateKey = privateKey
  }

  /**
   * Applies a BRC-103 signature to the payload.
   * Secures the A2A communication channel by verifying agent identities.
   */
  signMessage(payload: any): { signature: string, pubkey: string } {
    const payloadStr = JSON.stringify(payload)
    const pubkey = this.privateKey.toPublicKey().toString()
    
    const message = Utils.toArray(payloadStr, 'utf8')
    const signatureArray = SignedMessage.sign(message, this.privateKey)
    const signature = Utils.toBase64(signatureArray)
    
    return { signature, pubkey }
  }

  verifySignature(payload: any, signature: string, pubkeyHex: string): boolean {
    try {
      const payloadStr = JSON.stringify(payload)
      const message = Utils.toArray(payloadStr, 'utf8')
      const signatureArray = Utils.toArray(signature, 'base64')
      
      if (!SignedMessage.verify(message, signatureArray)) return false

      const reader = new Utils.Reader(signatureArray)
      reader.read(4) // Skip version
      const signerPubkey = Utils.toHex(reader.read(33))
      
      return signerPubkey === pubkeyHex
    } catch {
      return false
    }
  }

  createRequest<T>(method: A2AMessageType, params: T, id: string = Math.random().toString(36).substring(7)): JSONRPCRequest<T> {
    const req: JSONRPCRequest<T> = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }
    const { signature, pubkey } = this.signMessage({ id, method, params })
    req.signature = signature
    req.pubkey = pubkey
    return req
  }

  createResponse<T>(id: string | number, result: T): JSONRPCResponse<T> {
    const res: JSONRPCResponse<T> = {
      jsonrpc: '2.0',
      id,
      result
    }
    const { signature, pubkey } = this.signMessage({ id, result })
    res.signature = signature
    res.pubkey = pubkey
    return res
  }
}

export class TaskManager {
  private tasks = new Map<string, { state: TaskState, retries: number }>()

  submitTask(taskId: string) {
    this.tasks.set(taskId, { state: 'submitted', retries: 0 })
    console.log(`[TaskManager] Task ${taskId} submitted.`)
  }

  updateTask(taskId: string, state: TaskState) {
    const task = this.tasks.get(taskId)
    if (task) {
      task.state = state
      this.tasks.set(taskId, task)
      console.log(`[TaskManager] Task ${taskId} state updated to ${state}.`)
    }
  }

  /**
   * Executes a task with timeout and retry logic.
   * Artifacts can be streamed via SSE during the 'working' phase.
   */
  async executeTaskWithTimeout<T>(
    taskId: string, 
    fn: () => Promise<T>, 
    timeoutMs: number = 5000,
    maxRetries: number = 3
  ): Promise<T> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)

    while (task.retries <= maxRetries) {
      try {
        this.updateTask(taskId, 'working')
        const timeout = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Task timeout')), timeoutMs)
        )
        const result = await Promise.race([fn(), timeout])
        this.updateTask(taskId, 'completed')
        return result
      } catch (e) {
        task.retries++
        console.warn(`[TaskManager] Task ${taskId} failed (attempt ${task.retries}/${maxRetries}): ${e}`)
        if (task.retries > maxRetries) {
          this.updateTask(taskId, 'failed')
          throw e
        }
        // Exponential backoff
        await new Promise(r => setTimeout(r, 1000 * task.retries))
      }
    }
    throw new Error('Task execution failed after retries')
  }
}
