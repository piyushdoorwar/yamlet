using System.Collections.Generic;
using AvaloniaEdit.Document;
using AvaloniaEdit.Folding;

namespace Yamlet.App.Controls;

/// <summary>
/// Produces collapsible regions for JSON: every multi-line <c>{…}</c> object and
/// <c>[…]</c> array becomes a fold. Braces inside string literals are ignored so URLs
/// or text containing brackets don't create spurious folds.
/// </summary>
public sealed class JsonFoldingStrategy
{
    public void UpdateFoldings(FoldingManager manager, TextDocument document) =>
        manager.UpdateFoldings(CreateFoldings(document), -1);

    private static IEnumerable<NewFolding> CreateFoldings(TextDocument document)
    {
        var foldings = new List<NewFolding>();
        var stack = new Stack<int>();
        var text = document.Text;
        var inString = false;

        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (inString)
            {
                if (c == '\\')
                {
                    i++; // skip the escaped character
                }
                else if (c == '"')
                {
                    inString = false;
                }
                continue;
            }

            switch (c)
            {
                case '"':
                    inString = true;
                    break;
                case '{':
                case '[':
                    stack.Push(i);
                    break;
                case '}':
                case ']':
                    if (stack.Count > 0)
                    {
                        var start = stack.Pop();
                        var end = i + 1;
                        var startLine = document.GetLineByOffset(start).LineNumber;
                        var endLine = document.GetLineByOffset(i).LineNumber;
                        if (endLine > startLine)
                        {
                            foldings.Add(new NewFolding(start, end)
                            {
                                Name = text[start] == '{' ? "{ … }" : "[ … ]",
                            });
                        }
                    }
                    break;
            }
        }

        // FoldingManager.UpdateFoldings requires foldings ordered by start offset.
        foldings.Sort((a, b) => a.StartOffset.CompareTo(b.StartOffset));
        return foldings;
    }
}
