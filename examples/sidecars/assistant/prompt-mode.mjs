export function selectPromptMode({ provider, hasConversation, conversation, toolResults }) {
  if (toolResults.length > 0 && hasConversation) {
    return { mode: 'toolContinuation', resetNativeConversation: false }
  }
  // A freshly loaded workstation has no local transcript even if its prior
  // ChatGPT browser conversation is still bound to the same client session.
  const resetNativeConversation = provider === 'chatgpt'
    && hasConversation
    && Array.isArray(conversation)
    && conversation.length === 0
  return {
    mode: hasConversation && !resetNativeConversation ? 'followUp' : 'full',
    resetNativeConversation
  }
}
