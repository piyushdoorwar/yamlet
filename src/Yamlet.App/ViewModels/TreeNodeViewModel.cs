using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Yamlet.App.Models;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Base node in the workspace tree. Concrete subclasses represent collections,
/// folders and requests; views select a template based on the runtime type.
/// </summary>
public abstract partial class TreeNodeViewModel : ViewModelBase
{
    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private bool _isExpanded = true;

    public ObservableCollection<TreeNodeViewModel> Children { get; } = new();

    /// <summary>The parent node, or null for top-level collection nodes.</summary>
    public TreeNodeViewModel? Parent { get; init; }
}

/// <summary>A collection node. Children are its folders and direct requests.</summary>
public sealed class CollectionNodeViewModel : TreeNodeViewModel
{
    public required YamletCollection Collection { get; init; }
}

/// <summary>A folder node within a collection.</summary>
public sealed class FolderNodeViewModel : TreeNodeViewModel
{
    public required YamletFolder Folder { get; init; }
    public required YamletCollection OwningCollection { get; init; }
}

/// <summary>A request leaf node, carrying its HTTP method for compact display.</summary>
public sealed partial class RequestNodeViewModel : TreeNodeViewModel
{
    public required YamletRequest Request { get; init; }
    public required YamletCollection OwningCollection { get; init; }
    public YamletFolder? ParentFolder { get; init; }

    [ObservableProperty]
    private string _method = "GET";

    /// <summary>Uppercased method text shown before the request name.</summary>
    public string MethodLabel => FormatMethod(Method);

    partial void OnMethodChanged(string value) => OnPropertyChanged(nameof(MethodLabel));

    private static string FormatMethod(string? method)
    {
        var normalized = string.IsNullOrWhiteSpace(method) ? "GET" : method.ToUpperInvariant();
        return normalized == "DELETE" ? "DEL" : normalized;
    }
}
